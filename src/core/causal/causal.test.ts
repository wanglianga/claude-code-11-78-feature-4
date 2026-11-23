// ============================================================
// 因果推断引擎测试（Vitest，纯函数无需浏览器）：
//  1. 同依赖簇（雨量站+网关共用配电箱同时失联）不叠加为双重支持；
//  2. 排水恢复后浓度仍升高 → “仅积水导致异常”受反驳，不确定性传导下游安全判断；
//  3. 仅接收时间戳且链路延迟未知的唯一反驳证据不能排除假设；
//  4. 维修结论改变边适用条件 → 生成新推断版本，冻结处置理由持续引用旧版。
// 另覆盖：缺证沿图传播（无反证→未知）、稳健性翻转与区间保留。
// ============================================================

import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import {
  ANALYSIS_WINDOW,
  buildCausalEvidence,
  buildCausalGraph,
  buildClusters,
  buildV2ChangeSet,
} from './causalScenario';
import {
  DEFAULT_SCENARIOS,
  detectChannelFailures,
  evidenceInWindow,
  propagateMissingEvidence,
  robustnessAnalysis,
  rootCauseVerdicts,
  scoreClaims,
  verdictLabel,
  windowWithTolerance,
} from './causalEngine';
import {
  applyMaintenanceChange,
  createInitialVersion,
  createNextVersion,
  freezeRationale,
} from './causalVersion';
import { causalRepository } from './causalRepository';
import { resetAll } from '../db';
import type { CausalEvidence } from './types';

const WINDOW = { start: ANALYSIS_WINDOW.start, end: ANALYSIS_WINDOW.end };
const RECOVERED_AT = '2026-07-15T16:20:00+08:00';

function build() {
  return {
    graph: buildCausalGraph(),
    evidence: buildCausalEvidence(),
    clusters: buildClusters(),
  };
}

const baseOpts = {
  window: WINDOW,
  toleranceMin: 15,
  recoveredAt: RECOVERED_AT,
};

describe('依赖簇合并', () => {
  it('雨量站与网关共用配电箱同时失联时归为同一簇，不叠加为暴雨的双重支持', () => {
    const { graph, evidence, clusters } = build();
    const scores = scoreClaims(graph, evidence, clusters, baseOpts);
    const stormFlood = scores.find((s) => s.claimId === 'CL-STORM-FLOOD')!;

    // 指向该主张的证据：CE-01（雨量，CL-BOX-A）、CE-04（供电间接信号，CL-BOX-A）、CE-05（水位，CL-SENSOR）
    const boxA = stormFlood.clusterContributions.find((c) => c.clusterId === 'CL-BOX-A')!;
    expect(boxA.evidenceIds.sort()).toEqual(['CE-01', 'CE-04']);
    // 同簇两条只合并成 1 个贡献，权重为簇内最低可靠度且受共链路封顶 0.6
    expect(stormFlood.clusterContributions.filter((c) => c.clusterId === 'CL-BOX-A')).toHaveLength(1);
    expect(boxA.weight).toBe(0.6);
    // 独立传感器簇另计一个贡献
    const sensor = stormFlood.clusterContributions.find((c) => c.clusterId === 'CL-SENSOR')!;
    expect(sensor.evidenceIds).toEqual(['CE-05']);
    // 总支持量 = 0.6（封顶）+ 1.0，而非 0.6+0.6+1.0 的双重叠加
    expect(stormFlood.support).toBeCloseTo(1.6, 5);
    expect(stormFlood.verdict).toBe('support');
  });

  it('多条网关心跳同簇时不产生多个独立佐证', () => {
    const { graph, clusters } = build();
    // 构造同簇两条心跳，均支持 CL-POWER-GW
    const evidence: CausalEvidence[] = [
      ...buildCausalEvidence(),
      {
        id: 'CE-HB-2', kind: 'gateway_heartbeat', label: '心跳重复记录 2', source: 'gateway-07',
        reliability: 'medium', clusterId: 'CL-BOX-A',
        interval: { start: '2026-07-15T14:50:00+08:00', end: '2026-07-15T15:00:00+08:00', receiveOnly: false, delayUnknown: false, note: '' },
        observableKey: 'heartbeat_loss', polarity: 'support', claimId: 'CL-POWER-GW',
        detail: '', missing: false,
      },
    ];
    const scores = scoreClaims(graph, evidence, clusters, baseOpts);
    const powerGw = scores.find((s) => s.claimId === 'CL-POWER-GW')!;
    const boxA = powerGw.clusterContributions.find((c) => c.clusterId === 'CL-BOX-A')!;
    expect(boxA.evidenceIds).toContain('CE-03');
    expect(boxA.evidenceIds).toContain('CE-HB-2');
    // 仍然只有 1 个簇贡献、权重封顶 0.6
    expect(powerGw.clusterContributions).toHaveLength(1);
    expect(powerGw.support).toBeCloseTo(0.6, 5);
  });
});

describe('缺证传播与仅积水假设反驳', () => {
  it('排水恢复后浓度仍升高：仅积水假设受反驳，不确定性传导至下游安全判断', () => {
    const { graph, evidence, clusters } = build();
    const scores = scoreClaims(graph, evidence, clusters, baseOpts);
    const waterOnly = scores.find((s) => s.claimId === 'CL-WATER-ONLY')!;
    expect(waterOnly.verdict).toBe('refute');
    // CE-08 浓度持续升高直接反驳
    expect(waterOnly.refute).toBeGreaterThan(0);
    // 缺证反证：sensor_recovery 在通道恢复后仍缺失
    const missingRecovery = waterOnly.missingCounterEvidence.find((m) => m.observableKey === 'sensor_recovery');
    expect(missingRecovery).toBeDefined();
    expect(missingRecovery!.reason).toContain('恢复');

    const roots = rootCauseVerdicts(graph, scores);
    expect(roots.get('H-WATER-ONLY')).toBe('refute');

    const prop = propagateMissingEvidence(graph, evidence, scores, baseOpts);
    const safety = prop.impactedJudgements.find((j) => j.nodeId === 'I-SAFETY')!;
    expect(safety.state).toBe('refuted');
    expect(safety.reason).toContain('禁止');
  });

  it('故障期视角：上游通道故障把下游主张由无反证降为未知', () => {
    const { graph, evidence, clusters } = build();
    const opts = { window: WINDOW, toleranceMin: 15 }; // 不给 recoveredAt，视为通道仍故障
    const scores = scoreClaims(graph, evidence, clusters, opts);
    const prop = propagateMissingEvidence(graph, evidence, scores, opts);
    const failures = detectChannelFailures(graph, evidence.filter((e) => !e.missing));
    expect(failures.map((f) => f.nodeId).sort()).toEqual(['M-GW', 'M-POWER']);

    const gwMissing = prop.items.find((i) => i.claimId === 'CL-GW-MISSING')!;
    // sensor_missing 被网关通道屏蔽：故障期内缺证降未知
    expect(gwMissing.after).toBe('unknown');
    expect(gwMissing.missingCounterEvidence.some((m) => m.reason.includes('未知'))).toBe(true);
  });
});

describe('仅接收时间证据的区间保护', () => {
  it('唯一反驳证据只记录接收时间且延迟未知：保留区间，不得据此排除假设', () => {
    const { graph, evidence, clusters } = build();
    const ce13 = evidence.find((e) => e.id === 'CE-13')!;
    expect(ce13.interval.receiveOnly).toBe(true);
    expect(ce13.interval.delayUnknown).toBe(true);

    // 扩大任何时间容差，区间始终与窗口相交，证据不被时间窗剔除
    for (const tol of [0, 30, 60, 90]) {
      const win = windowWithTolerance(WINDOW, tol);
      expect(evidenceInWindow(ce13, win)).toBe(true);
    }

    const scores = scoreClaims(graph, evidence, clusters, baseOpts);
    const stormFlood = scores.find((s) => s.claimId === 'CL-STORM-FLOOD')!;
    // CE-13 是该主张唯一的反驳证据，但不能把主张判为反驳
    expect(stormFlood.verdict).not.toBe('refute');
    expect(verdictLabel(stormFlood.verdict)).not.toBe('反驳');

    // 稳健性台在所有情景下同样不得把暴雨根因判为反驳
    const rows = robustnessAnalysis(graph, evidence, clusters, baseOpts, DEFAULT_SCENARIOS);
    const storm = rows.find((r) => r.rootCauseId === 'RC-STORM')!;
    expect(storm.scenarios.every((s) => s.verdict !== 'refute')).toBe(true);
  });
});

describe('维修结论与推断版本', () => {
  it('维修结论改变边适用条件时生成新版本，冻结处置理由继续引用当时的图与证据范围', () => {
    const { graph, evidence } = build();
    const v1 = createInitialVersion({
      graph,
      evidence,
      toleranceMin: 15,
      createdAt: '2026-07-15T18:00:00+08:00',
    });
    expect(v1.id).toBe('IV-v1');
    expect(v1.graphSnapshot.edges.find((e) => e.id === 'CL-POWER-GW')!.enabled).toBe(true);

    const changeSet = buildV2ChangeSet();
    const graphV2 = applyMaintenanceChange(graph, changeSet);
    // 旧图不被改写
    expect(graph.nodes.find((n) => n.id === 'P-BOX')!.holds).toBe(true);
    expect(graph.edges.find((e) => e.id === 'CL-POWER-GW')!.enabled).toBe(true);
    // 新图前提失效、旧边停用、新边加入
    expect(graphV2.nodes.find((n) => n.id === 'P-BOX')!.holds).toBe(false);
    expect(graphV2.edges.find((e) => e.id === 'CL-POWER-GW')!.enabled).toBe(false);
    expect(graphV2.edges.find((e) => e.id === 'CL-FLOOD-GW')).toBeDefined();

    const v2 = createNextVersion({
      parent: v1,
      newGraph: graphV2,
      evidence,
      toleranceMin: 15,
      changeSet,
      createdAt: '2026-07-16T09:30:00+08:00',
    });
    expect(v2.id).toBe('IV-v2');
    expect(v2.parentVersionId).toBe('IV-v1');
    expect(v2.triggeredByEvidenceId).toBe('CE-14');

    // 在 v2 图上，CL-POWER-GW 因前提失败而证据不足
    const clusters = buildClusters();
    const scoresV2 = scoreClaims(graphV2, evidence, clusters, baseOpts);
    expect(scoresV2.find((s) => s.claimId === 'CL-POWER-GW')!.preconditionFailed).toBe(true);
    expect(scoresV2.find((s) => s.claimId === 'CL-POWER-GW')!.verdict).toBe('insufficient');

    // 冻结处置理由：引用 v1 的图与证据范围
    const { rationale, freezeVersionId } = freezeRationale({
      version: v1,
      eventRef: 'WO-1',
      rootCauseId: 'RC-STORM',
      rootCauseLabel: '暴雨',
      verdict: 'support',
      comment: '冻结测试',
      createdAt: '2026-07-16T09:30:00+08:00',
      scores: scoreClaims(graph, evidence, clusters, baseOpts),
    });
    expect(freezeVersionId).toBe('IV-v1');
    expect(rationale.inferenceVersionId).toBe('IV-v1');
    expect(rationale.frozenClaimSummary.length).toBeGreaterThan(0);
    // 理由快照仍引用旧图中的启用边
    const v1Edge = v1.graphSnapshot.edges.find((e) => e.id === 'CL-POWER-GW')!;
    expect(v1Edge.enabled).toBe(true);
  });
});

describe('稳健性台', () => {
  it('删除关键簇会使对应根因结论翻转，基线结论与翻转计数一致', () => {
    const { graph, evidence, clusters } = build();
    const rows = robustnessAnalysis(graph, evidence, clusters, baseOpts, DEFAULT_SCENARIOS);
    const labels = Object.fromEntries(rows.map((r) => [r.rootCauseId, r]));

    // 仅积水假设基线受反驳（浓度升高）
    expect(labels['H-WATER-ONLY'].baseline).toBe('refute');
    // 删除井场传感器簇后，浓度反证消失 → 结论发生翻转
    const dropSensor = labels['H-WATER-ONLY'].scenarios.find((s) => s.scenarioId === 'RB-DROP-SENSOR')!;
    expect(dropSensor.flipped).toBe(true);
    expect(dropSensor.verdict).not.toBe('refute');

    // 每个根因都有全部情景的结果
    for (const r of rows) {
      expect(r.scenarios).toHaveLength(DEFAULT_SCENARIOS.length);
      expect(r.flipCount).toBe(r.scenarios.filter((s) => s.flipped).length);
    }
  });

  it('所有结论只取值 支持/反驳/证据不足', () => {
    const { graph, evidence, clusters } = build();
    const rows = robustnessAnalysis(graph, evidence, clusters, baseOpts, DEFAULT_SCENARIOS);
    const allowed = new Set(['support', 'refute', 'insufficient']);
    for (const r of rows) {
      expect(allowed.has(r.baseline)).toBe(true);
      for (const s of r.scenarios) expect(allowed.has(s.verdict)).toBe(true);
    }
  });
});

describe('因果仓储 IndexedDB 落盘与冻结保护', () => {
  it('图/证据/簇/版本可回读，冻结版本拒绝改写，处置理由可溯源', async () => {
    await resetAll();
    const { graph, evidence, clusters } = build();
    const v1 = createInitialVersion({
      graph,
      evidence,
      toleranceMin: 15,
      createdAt: '2026-07-15T18:00:00+08:00',
    });
    await Promise.all([
      causalRepository.saveGraph(graph),
      causalRepository.saveEvidence(evidence),
      causalRepository.saveClusters(clusters),
      causalRepository.addVersion(v1),
    ]);
    const [g2, ev2, cl2, vs2] = await Promise.all([
      causalRepository.graph(),
      causalRepository.evidence(),
      causalRepository.clusters(),
      causalRepository.versions(),
    ]);
    expect(g2?.id).toBe('CG-FLOOD-1');
    expect(ev2.length).toBe(evidence.length);
    expect(cl2.length).toBe(clusters.length);
    expect(vs2).toHaveLength(1);

    // 冻结后同 ID 写入必须被拒绝
    await causalRepository.freezeVersion('IV-v1');
    await expect(causalRepository.addVersion({ ...v1, reason: '试图改写冻结版本' })).rejects.toThrow();

    // 新版本仍可沿版本链新增
    const graphV2 = applyMaintenanceChange(graph, buildV2ChangeSet());
    const v2 = createNextVersion({
      parent: (await causalRepository.versions())[0],
      newGraph: graphV2,
      evidence,
      toleranceMin: 15,
      changeSet: buildV2ChangeSet(),
      createdAt: '2026-07-16T09:30:00+08:00',
    });
    await causalRepository.addVersion(v2);
    const all = await causalRepository.versions();
    expect(all.map((v) => v.id)).toEqual(['IV-v1', 'IV-v2']);
    // 旧版本快照保持冻结时的图（CL-POWER-GW 仍启用）
    expect(all[0].graphSnapshot.edges.find((e) => e.id === 'CL-POWER-GW')!.enabled).toBe(true);
    expect(all[1].graphSnapshot.edges.find((e) => e.id === 'CL-POWER-GW')!.enabled).toBe(false);

    const { rationale } = freezeRationale({
      version: all[0],
      eventRef: 'WO-1',
      rootCauseId: 'RC-STORM',
      rootCauseLabel: '暴雨',
      verdict: 'support',
      comment: '冻结处置理由',
      createdAt: '2026-07-16T09:30:00+08:00',
      scores: scoreClaims(graph, evidence, clusters, baseOpts),
    });
    await causalRepository.addRationale(rationale);
    const rs = await causalRepository.rationales();
    expect(rs).toHaveLength(1);
    expect(rs[0].inferenceVersionId).toBe('IV-v1');
    expect(rs[0].frozenClaimSummary.length).toBeGreaterThan(0);
  });
});
