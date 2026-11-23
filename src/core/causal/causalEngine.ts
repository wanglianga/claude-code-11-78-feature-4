// ============================================================
// 因果推理引擎（纯函数，Worker/测试/UI 共用）
//
// 计算顺序（严格遵循任务约束）：
//   1. 时间区间匹配：证据以区间参与匹配；仅知接收时间的证据保留整段
//      区间，任何时间容差情景都不得按单点时间戳剔除它；
//   2. 依赖簇内合并：同簇多条证据只产生一个簇贡献，绝不叠加；
//   3. 主张评分：支持量、反驳量、无法判定区间，结论仅输出
//      支持 / 反驳 / 证据不足；
//   4. 缺证传播：上游通道故障把下游主张由“无反证”降为“未知”，
//      并区分通道屏蔽缺证与“本应出现却缺失”的缺证反证；
//   5. 稳健性情景：删簇 / 扩时间容差 / 替换可靠度后比较根因翻转。
// ============================================================

import type {
  CausalEvidence,
  CausalGraph,
  ClaimScore,
  ClaimVerdict,
  ClusterContribution,
  DependencyCluster,
  EpistemicState,
  PropagationItem,
  PropagationResult,
  Reliability,
  RobustnessScenario,
  RootCauseRobustnessRow,
  TimeInterval,
} from './types';

export const RELIABILITY_WEIGHT: Record<Reliability, number> = {
  high: 1,
  medium: 0.6,
  low: 0.3,
};

/** 共链路簇的可靠度上界：单一失效即可解释簇内全部记录，不允许达到 high 权重 */
const SHARED_CLUSTER_CAP = 0.6;
/** 缺证反证（通道正常却缺失应有观测）的计权：弱于直接观测证据，单独不足以定性 */
const MISSING_COUNTER_WEIGHT = 0.4;
/** 结论判定的最小证据量门槛 */
const VERDICT_FLOOR = 0.5;

// ---------------- 时间区间 ----------------

export function intervalOverlap(a: TimeInterval, b: TimeInterval): boolean {
  return new Date(a.start).getTime() <= new Date(b.end).getTime()
    && new Date(b.start).getTime() <= new Date(a.end).getTime();
}

/** 分析窗口外扩时间容差 */
export function windowWithTolerance(
  window: { start: string; end: string },
  toleranceMin: number,
): TimeInterval {
  const ms = toleranceMin * 60_000;
  const fmt = (ms2: number) => {
    const d = new Date(ms2 + 8 * 3600_000);
    return d.toISOString().replace('Z', '+08:00');
  };
  return {
    start: fmt(new Date(window.start).getTime() - ms),
    end: fmt(new Date(window.end).getTime() + ms),
    receiveOnly: false,
    delayUnknown: false,
    note: `分析窗口外扩 ${toleranceMin} 分钟`,
  };
}

/**
 * 证据是否落在（容差后的）分析窗口内。
 * 关键约束：receiveOnly 证据按整段区间判定——只要区间与窗口相交就保留，
 * 任何情景都不能以“单点时间对不上”为由剔除它。
 */
export function evidenceInWindow(e: CausalEvidence, win: TimeInterval): boolean {
  return intervalOverlap(e.interval, win);
}

// ---------------- 依赖簇合并 ----------------

function clusterWeight(
  rows: CausalEvidence[],
  cluster: DependencyCluster | undefined,
  reliabilityOverride?: Record<string, Reliability>,
): number {
  let w = Math.min(
    ...rows.map((r) => RELIABILITY_WEIGHT[reliabilityOverride?.[r.source] ?? r.reliability]),
  );
  if (cluster?.sharedFailure) w = Math.min(w, SHARED_CLUSTER_CAP);
  return +w.toFixed(3);
}

function mergeCluster(
  clusterId: string,
  rows: CausalEvidence[],
  cluster: DependencyCluster | undefined,
  reliabilityOverride?: Record<string, Reliability>,
): ClusterContribution {
  const supports = rows.filter((r) => r.polarity === 'support');
  const refutes = rows.filter((r) => r.polarity === 'refute');
  const w = clusterWeight(rows, cluster, reliabilityOverride);
  const polarities = new Set(rows.map((r) => r.polarity));
  const conflict = supports.length > 0 && refutes.length > 0;

  let mergedPolarity: ClusterContribution['mergedPolarity'];
  if (conflict) {
    const sw = Math.max(...supports.map((r) => RELIABILITY_WEIGHT[reliabilityOverride?.[r.source] ?? r.reliability]));
    const rw = Math.max(...refutes.map((r) => RELIABILITY_WEIGHT[reliabilityOverride?.[r.source] ?? r.reliability]));
    mergedPolarity = sw === rw ? 'conflict' : sw > rw ? 'support' : 'refute';
  } else if (supports.length > 0) {
    mergedPolarity = 'support';
  } else if (refutes.length > 0) {
    mergedPolarity = 'refute';
  } else {
    mergedPolarity = 'neutral';
  }
  if (polarities.has('neutral') && !conflict && supports.length === 0 && refutes.length === 0) {
    mergedPolarity = 'neutral';
  }

  const detail = conflict
    ? `簇 ${clusterId} 内同时存在 ${supports.length} 条支持与 ${refutes.length} 条反驳，按最高可靠度极性合并为「${mergedPolarity}」，同簇不叠加`
    : `簇 ${clusterId} 内 ${rows.length} 条同源证据合并为 1 个贡献（${cluster?.sharedFailure ? '共链路簇，权重封顶 0.6；' : ''}权重 ${w}）`;

  return {
    clusterId,
    evidenceIds: rows.map((r) => r.id),
    mergedPolarity,
    weight: w,
    detail,
  };
}

// ---------------- 通道故障与缺证 ----------------

export interface ChannelFailure {
  nodeId: string;
  label: string;
  blocked: string[];
}

/**
 * 通道故障由机制节点的 blocksObservables 与故障证据共同确定：
 * 存在对应故障观测证据（且未被恢复证据完全覆盖）即视为通道在窗口内失效。
 */
export function detectChannelFailures(graph: CausalGraph, evidence: CausalEvidence[]): ChannelFailure[] {
  const failures: ChannelFailure[] = [];
  const observableEvidence = new Map<string, CausalEvidence[]>();
  for (const e of evidence) {
    if (e.missing) continue;
    observableEvidence.set(e.observableKey, [...(observableEvidence.get(e.observableKey) ?? []), e]);
  }
  for (const node of graph.nodes) {
    if (node.kind !== 'mechanism' || !node.blocksObservables?.length) continue;
    // 机制节点激活：其屏蔽的观测键中至少一个有故障证据
    const active = node.blocksObservables.some((key) => (observableEvidence.get(key) ?? []).length > 0);
    if (active) {
      failures.push({ nodeId: node.id, label: node.label, blocked: [...node.blocksObservables] });
    }
  }
  return failures;
}

// ---------------- 主张评分 ----------------

export interface ScoreOptions {
  window: { start: string; end: string };
  toleranceMin: number;
  droppedClusterIds?: string[];
  reliabilityOverride?: Record<string, Reliability>;
  /** 通道恢复时间；此后缺失的观测不再算通道屏蔽，而算缺证反证 */
  recoveredAt?: string;
}

export function scoreClaims(
  graph: CausalGraph,
  evidenceAll: CausalEvidence[],
  clusters: DependencyCluster[],
  opts: ScoreOptions,
): ClaimScore[] {
  const win = windowWithTolerance(opts.window, opts.toleranceMin);
  const clusterById = new Map(clusters.map((c) => [c.id, c]));
  const evidence = evidenceAll.filter(
    (e) =>
      !e.missing &&
      !(opts.droppedClusterIds ?? []).includes(e.clusterId) &&
      evidenceInWindow(e, win),
  );
  const failures = detectChannelFailures(graph, evidence);
  const recoveredMs = opts.recoveredAt ? new Date(opts.recoveredAt).getTime() : null;

  return graph.edges.map((edge) => {
    const preconditionFailed =
      !edge.enabled ||
      edge.preconditionIds.some((pid) => graph.nodes.find((n) => n.id === pid)?.holds === false);

    const related = evidence.filter((e) => e.claimId === edge.id);
    const byCluster = new Map<string, CausalEvidence[]>();
    for (const e of related) {
      byCluster.set(e.clusterId, [...(byCluster.get(e.clusterId) ?? []), e]);
    }
    const contributions = [...byCluster.entries()].map(([cid, rows]) =>
      mergeCluster(cid, rows, clusterById.get(cid), opts.reliabilityOverride),
    );

    let support = 0;
    let refute = 0;
    let unknownMass = 0;
    for (const c of contributions) {
      if (c.mergedPolarity === 'support') support += c.weight;
      else if (c.mergedPolarity === 'refute') refute += c.weight;
      else unknownMass += c.weight; // conflict / neutral
    }

    // 缺证反证 vs 通道屏蔽缺证。
    // 同一失效通道屏蔽的多个缺失观测不叠加（与依赖簇同理）：按屏蔽通道分组，
    // 每个通道最多贡献一次缺证权重；通道正常的独立缺失观测各自分组。
    const missingCounterEvidence: ClaimScore['missingCounterEvidence'] = [];
    const presentKeys = new Set(evidence.map((e) => e.observableKey));
    const unknownGroups = new Set<string>();
    const refuteGroups = new Set<string>();
    const dropped = new Set(opts.droppedClusterIds ?? []);
    // 观测键 → 全量证据中提供该键的依赖簇
    const keyClusters = new Map<string, Set<string>>();
    for (const e of evidenceAll.filter((x) => !x.missing)) {
      const set = keyClusters.get(e.observableKey) ?? new Set<string>();
      set.add(e.clusterId);
      keyClusters.set(e.observableKey, set);
    }
    for (const key of edge.expectedCounterObservables) {
      if (presentKeys.has(key)) continue; // 已有观测（无论极性），不算缺证
      const blocker = failures.find((f) => f.blocked.includes(key));
      // 该键的来源簇是否在本情景中被整体删除：删除来源造成的不可观测只能计未知
      const owners = keyClusters.get(key);
      const sourceDropped =
        owners !== undefined && owners.size > 0 && [...owners].every((c) => dropped.has(c));
      if (blocker && recoveredMs === null) {
        // 通道仍处于故障期：缺失降为未知，不得视为“无反证”
        missingCounterEvidence.push({
          observableKey: key,
          reason: '上游通道故障屏蔽该观测，缺证降为未知，不得视为“无反证”',
        });
        unknownGroups.add(blocker.nodeId);
      } else if (sourceDropped) {
        missingCounterEvidence.push({
          observableKey: key,
          reason: '提供该观测的来源簇已在稳健性情景中删除，缺证不可用于反驳，计为未知',
        });
        unknownGroups.add(`dropped:${key}`);
      } else if (blocker) {
        // 通道曾故障但已于 recoveredAt 恢复：恢复后仍观测不到 → 缺证反证（同通道只计一次）
        missingCounterEvidence.push({
          observableKey: key,
          reason:
            `通道 ${blocker.label} 已于 ${opts.recoveredAt} 恢复，但该观测仍缺失，`
            + '按“本应出现却未出现”计为缺证反证（同通道缺证不叠加）',
        });
        refuteGroups.add(blocker.nodeId);
      } else {
        // 通道正常（或该观测不依赖任何已采来源，如“应恢复上报”）：
        // 假设成立本应出现却没有出现 → 缺证反证（按观测独立分组）
        missingCounterEvidence.push({
          observableKey: key,
          reason: '通道正常但该可观测反证缺失，按“本应出现却未出现”计为缺证反证',
        });
        refuteGroups.add(`healthy:${key}`);
      }
    }
    unknownMass += unknownGroups.size * MISSING_COUNTER_WEIGHT;
    refute += refuteGroups.size * MISSING_COUNTER_WEIGHT;

    support = +support.toFixed(3);
    refute = +refute.toFixed(3);
    unknownMass = +unknownMass.toFixed(3);

    // 强制约束：唯一反驳证据只记录接收时间且链路延迟未知时，
    // 保留其时间区间，但不得据此把主张判为反驳（降为证据不足）。
    const refuteRows = related.filter((e) => e.polarity === 'refute');
    const refuteOnlyByReceiveOnly =
      refuteRows.length > 0 &&
      refuteRows.every((e) => e.interval.receiveOnly && e.interval.delayUnknown) &&
      // 直接观测型反驳全部来自仅接收时间证据；缺证反证不计入此豁免
      refuteRows.every((e) => edge.expectedCounterObservables.includes(e.observableKey) === false);

    let verdict: ClaimVerdict;
    if (preconditionFailed) {
      verdict = 'insufficient';
    } else if (refute > support && refute >= VERDICT_FLOOR) {
      verdict = refuteOnlyByReceiveOnly ? 'insufficient' : 'refute';
    } else if (support > refute && support >= VERDICT_FLOOR) {
      verdict = 'support';
    } else {
      verdict = 'insufficient';
    }

    const rationale = preconditionFailed
      ? `适用前提不成立，主张停用，结论为证据不足`
      : `支持量 ${support}（${contributions.filter((c) => c.mergedPolarity === 'support').length} 簇）、`
        + `反驳量 ${refute}（${contributions.filter((c) => c.mergedPolarity === 'refute').length} 簇）、`
        + `未知质量 ${unknownMass}；净支持区间 [${(support - refute - unknownMass).toFixed(2)}, `
        + `${(support - refute + unknownMass).toFixed(2)}] → ${verdictLabel(verdict)}`;

    return {
      claimId: edge.id,
      edgeLabel: edge.label,
      from: edge.from,
      to: edge.to,
      support,
      refute,
      unknownRange: {
        low: +(support - refute - unknownMass).toFixed(3),
        high: +(support - refute + unknownMass).toFixed(3),
      },
      verdict,
      clusterContributions: contributions,
      preconditionFailed,
      missingCounterEvidence,
      rationale,
    };
  });
}

export function verdictLabel(v: ClaimVerdict): string {
  return v === 'support' ? '支持' : v === 'refute' ? '反驳' : '证据不足';
}

/**
 * 根因结论：综合该根因节点的全部关联主张（出边 + 入边）。
 * 任一强反驳即受反驳；否则有支持则支持；都不足则证据不足。
 * 结论只取 支持 / 反驳 / 证据不足，最高分不直接认定根因。
 */
export function rootCauseVerdicts(graph: CausalGraph, scores: ClaimScore[]): Map<string, ClaimVerdict> {
  const result = new Map<string, ClaimVerdict>();
  for (const node of graph.nodes.filter((n) => n.kind === 'root_cause')) {
    const related = scores.filter((s) => s.from === node.id || s.to === node.id);
    if (related.length === 0) {
      result.set(node.id, 'insufficient');
      continue;
    }
    if (related.some((s) => s.verdict === 'refute')) result.set(node.id, 'refute');
    else if (related.some((s) => s.verdict === 'support')) result.set(node.id, 'support');
    else result.set(node.id, 'insufficient');
  }
  return result;
}

// ---------------- 缺证传播 ----------------

export function propagateMissingEvidence(
  graph: CausalGraph,
  evidenceAll: CausalEvidence[],
  scores: ClaimScore[],
  opts: ScoreOptions,
): PropagationResult {
  const win = windowWithTolerance(opts.window, opts.toleranceMin);
  const evidence = evidenceAll.filter(
    (e) => !e.missing && !(opts.droppedClusterIds ?? []).includes(e.clusterId) && evidenceInWindow(e, win),
  );
  const failures = detectChannelFailures(graph, evidence);
  const scoreById = new Map(scores.map((s) => [s.claimId, s]));
  const presentKeys = new Set(evidence.map((e) => e.observableKey));

  const items: PropagationItem[] = graph.edges.map((edge) => {
    const score = scoreById.get(edge.id)!;
    const blockedObservables = edge.expectedCounterObservables.filter((k) =>
      failures.some((f) => f.blocked.includes(k)),
    );
    const blockedBy = failures.filter((f) => blockedObservables.some((k) => f.blocked.includes(k))).map((f) => f.nodeId);

    // 传播前：只看直接证据时的认识状态
    let before: EpistemicState;
    if (score.verdict === 'refute') before = 'refuted';
    else if (score.verdict === 'support') before = 'confirmed';
    else before = 'no_counter';

    // 传播后
    let after: EpistemicState = before;
    const missingCounters: PropagationItem['missingCounterEvidence'] = [];
    for (const key of edge.expectedCounterObservables) {
      if (presentKeys.has(key)) continue;
      if (blockedObservables.includes(key)) {
        missingCounters.push({
          observableKey: key,
          reason: '上游通道故障期间该观测不可得：由“无反证”降为“未知”',
        });
      } else {
        missingCounters.push({
          observableKey: key,
          reason: '通道正常却缺失应有观测：缺证反证，假设受到实质反驳',
        });
      }
    }
    if (before === 'no_counter' && blockedObservables.some((k) => !presentKeys.has(k))) {
      after = 'unknown';
    }
    if (missingCounters.some((m) => m.reason.startsWith('通道正常'))) {
      after = 'refuted';
    }
    if (score.preconditionFailed) after = 'unknown';

    const explanation =
      after === before
        ? `认识状态保持「${epistemicLabel(before)}」`
        : `沿故障通道 ${blockedBy.join('、') || '—'} 传播：「${epistemicLabel(before)}」→「${epistemicLabel(after)}」`;

    return {
      claimId: edge.id,
      edgeLabel: edge.label,
      before,
      after,
      blockedBy,
      blockedObservables,
      missingCounterEvidence: missingCounters,
      explanation,
    };
  });

  // 下游安全判断的不确定性传导（沿图传递：可经中间节点回溯到上游主张）
  const impactedJudgements: PropagationResult['impactedJudgements'] = [];
  const stateByClaim = new Map(items.map((i) => [i.claimId, i.after]));
  // 反向可达：从目标节点沿边反向收集全部祖先主张
  const ancestorClaims = (targetId: string): string[] => {
    const keep = new Set<string>([targetId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const e of graph.edges) {
        if (keep.has(e.to) && !keep.has(e.from)) {
          keep.add(e.from);
          changed = true;
        }
      }
    }
    return graph.edges.filter((e) => keep.has(e.to) && keep.has(e.from)).map((e) => e.id);
  };
  for (const node of graph.nodes.filter((n) => n.kind === 'impact')) {
    const ancestorStates = ancestorClaims(node.id)
      .map((cid) => stateByClaim.get(cid))
      .filter((s): s is EpistemicState => s !== undefined);
    const anyRefuted = ancestorStates.some((s) => s === 'refuted');
    const anyUnknown = ancestorStates.some((s) => s === 'unknown');
    const state: EpistemicState = anyRefuted ? 'refuted' : anyUnknown ? 'unknown' : 'confirmed';
    const reason = anyRefuted
      ? '上游假设受反驳（如排水后浓度仍升高），不确定性经因果链传导至安全判断，禁止按原假设恢复供气'
      : anyUnknown
        ? '上游主张存在通道屏蔽缺证，安全判断证据不足，保持未知'
        : '上游主张均有支持且无反证';
    impactedJudgements.push({ nodeId: node.id, label: node.label, state, reason });
  }

  return {
    channelFailures: failures.map((f) => ({ nodeId: f.nodeId, label: f.label, blocked: f.blocked })),
    items,
    impactedJudgements,
  };
}

export function epistemicLabel(s: EpistemicState): string {
  switch (s) {
    case 'confirmed': return '已支持';
    case 'refuted': return '已反驳';
    case 'no_counter': return '无反证';
    case 'unknown': return '未知';
  }
}

// ---------------- 稳健性台 ----------------

export const DEFAULT_SCENARIOS: RobustnessScenario[] = [
  { id: 'RB-BASE', type: 'baseline', name: '基线（全部证据，容差 15 分钟）' },
  { id: 'RB-DROP-BOXA', type: 'drop_cluster', name: '删除配电箱 A 共链路簇', clusterId: 'CL-BOX-A' },
  { id: 'RB-DROP-SENSOR', type: 'drop_cluster', name: '删除井场传感器直连簇', clusterId: 'CL-SENSOR' },
  { id: 'RB-DROP-FIELD', type: 'drop_cluster', name: '删除现场人工链路簇', clusterId: 'CL-FIELD' },
  { id: 'RB-WIDEN-30', type: 'widen_tolerance', name: '时间容差扩大 +30 分钟', extraToleranceMin: 30 },
  { id: 'RB-WIDEN-60', type: 'widen_tolerance', name: '时间容差扩大 +60 分钟', extraToleranceMin: 60 },
  {
    id: 'RB-REL-DOWN', type: 'reliability_shift', name: '共链路簇可靠度下调（medium→low）',
    reliabilityOverride: {
      'rain-station-01': 'low',
      'gateway-07': 'low',
      'power-monitor-09': 'low',
    },
  },
  {
    id: 'RB-REL-UP', type: 'reliability_shift', name: '外部气象来源提权（low→medium）',
    reliabilityOverride: { 'weather-bureau-api': 'medium' },
  },
];

function scenarioOptions(base: ScoreOptions, s: RobustnessScenario): ScoreOptions {
  switch (s.type) {
    case 'drop_cluster':
      return { ...base, droppedClusterIds: [...(base.droppedClusterIds ?? []), s.clusterId!] };
    case 'widen_tolerance':
      return { ...base, toleranceMin: base.toleranceMin + (s.extraToleranceMin ?? 0) };
    case 'reliability_shift':
      return { ...base, reliabilityOverride: { ...base.reliabilityOverride, ...s.reliabilityOverride } };
    default:
      return base;
  }
}

export function robustnessAnalysis(
  graph: CausalGraph,
  evidence: CausalEvidence[],
  clusters: DependencyCluster[],
  baseOpts: ScoreOptions,
  scenarios: RobustnessScenario[] = DEFAULT_SCENARIOS,
): RootCauseRobustnessRow[] {
  const baselineScores = scoreClaims(graph, evidence, clusters, baseOpts);
  const baselineRoots = rootCauseVerdicts(graph, baselineScores);

  // 强制约束：仅接收时间的证据在任何容差情景下都不得被时间窗剔除
  for (const s of scenarios) {
    if (s.type !== 'widen_tolerance') continue;
    const opts = scenarioOptions(baseOpts, s);
    const win = windowWithTolerance(opts.window, opts.toleranceMin);
    for (const e of evidence.filter((x) => x.interval.receiveOnly)) {
      if (!evidenceInWindow(e, win)) {
        throw new Error(`仅接收时间证据 ${e.id} 的区间被时间容差情景 ${s.id} 错误排除`);
      }
    }
  }

  const rootNodes = graph.nodes.filter((n) => n.kind === 'root_cause');
  return rootNodes.map((node) => {
    const baseline = baselineRoots.get(node.id)!;
    const rows = scenarios.map((s) => {
      const opts = scenarioOptions(baseOpts, s);
      const scores = scoreClaims(graph, evidence, clusters, opts);
      const roots = rootCauseVerdicts(graph, scores);
      const verdict = roots.get(node.id)!;
      const flipped = s.type !== 'baseline' && verdict !== baseline;
      const note = flipped
        ? `相对基线翻转：${verdictLabel(baseline)} → ${verdictLabel(verdict)}`
        : `与基线一致：${verdictLabel(verdict)}`;
      return { scenarioId: s.id, verdict, flipped, note };
    });
    const flipCount = rows.filter((r) => r.flipped).length;
    return {
      rootCauseId: node.id,
      rootCauseLabel: node.label,
      baseline,
      scenarios: rows,
      flipCount,
      robust: flipCount === 0,
    };
  });
}
