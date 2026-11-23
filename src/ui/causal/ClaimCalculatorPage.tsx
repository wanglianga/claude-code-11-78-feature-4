import { Fragment, useMemo, useState } from 'react';
import { useCausal } from '../../state/causal';
import {
  ANALYSIS_WINDOW,
} from '../../core/causal/causalScenario';
import {
  scoreClaims,
  rootCauseVerdicts,
  verdictLabel,
  RELIABILITY_WEIGHT,
} from '../../core/causal/causalEngine';
import type { ClaimScore, ClaimVerdict } from '../../core/causal/types';

const RECOVERED_AT = '2026-07-15T16:20:00+08:00';

function RangeBar({ score }: { score: ClaimScore }) {
  const max = Math.max(1, score.support + score.refute + Math.abs(score.unknownRange.low), score.unknownRange.high);
  const pct = (n: number) => `${Math.max(0, (n / max) * 100)}%`;
  return (
    <div style={{ background: '#eef2f7', borderRadius: 6, height: 14, position: 'relative', overflow: 'hidden', minWidth: 180 }}>
      <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: pct(score.support), background: '#1a7f4b' }} title={`支持 ${score.support}`} />
      <div style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: pct(score.refute), background: '#b42318' }} title={`反驳 ${score.refute}`} />
    </div>
  );
}

const VERDICT_BADGE: Record<string, string> = {
  support: 'ok',
  refute: 'bad',
  insufficient: 'neutral',
};

export default function ClaimCalculatorPage() {
  const { ready, graph, evidence, clusters, toleranceMin, setToleranceMin, seed } = useCausal();
  const [openClaim, setOpenClaim] = useState<string>('');

  const scores = useMemo(() => {
    if (!graph) return [];
    return scoreClaims(graph, evidence, clusters, {
      window: { start: ANALYSIS_WINDOW.start, end: ANALYSIS_WINDOW.end },
      toleranceMin,
      recoveredAt: RECOVERED_AT,
    });
  }, [graph, evidence, clusters, toleranceMin]);

  const roots = useMemo(
    () => (graph ? rootCauseVerdicts(graph, scores) : new Map<string, ClaimVerdict>()),
    [graph, scores],
  );

  if (ready && !graph) {
    return (
      <div className="card">
        <h2>⑫ 支持 / 反驳计算器与主张区间</h2>
        <p className="muted small">尚未装载样例。</p>
        <button className="primary" onClick={() => void seed()}>装载汛期因果样例</button>
      </div>
    );
  }
  if (!graph) return <div className="card">加载中…</div>;

  return (
    <div>
      <div className="card">
        <h2>⑫ 支持 / 反驳计算器：簇内合并 → 主张区间 → 仅输出支持/反驳/证据不足</h2>
        <p className="muted small">
          计算顺序：先在同一依赖簇内合并同源证据（共链路簇权重封顶 0.6，多条心跳不独立计权），
          再对每条主张汇总支持量、反驳量与无法判定的可能范围。最高分仅为<b>待验证解释</b>，不直接认定根因。
        </p>
        <label className="small">
          时间容差：<strong>{toleranceMin}</strong> 分钟
          <input
            type="range" min={0} max={90} step={5} value={toleranceMin}
            onChange={(e) => setToleranceMin(Number(e.target.value))}
            style={{ margin: '0 10px', verticalAlign: 'middle' }}
          />
          分析窗口 {ANALYSIS_WINDOW.start.slice(11, 16)}–{ANALYSIS_WINDOW.end.slice(11, 16)}，
          通道恢复时间 {RECOVERED_AT.slice(11, 16)}
        </label>
      </div>

      <div className="card">
        <h3>候选根因结论（受反驳优先；无充分证据则证据不足）</h3>
        <table>
          <thead><tr><th>候选根因</th><th>当前结论</th><th>出边主张数</th><th>说明</th></tr></thead>
          <tbody>
            {graph.nodes.filter((n) => n.kind === 'root_cause').map((n) => {
              const v = roots.get(n.id)!;
              const outgoing = scores.filter((s) => s.from === n.id);
              return (
                <tr key={n.id}>
                  <td><strong>{n.label}</strong><div className="mono small muted">{n.id}</div></td>
                  <td><span className={`badge ${VERDICT_BADGE[v]}`}>{verdictLabel(v)}</span></td>
                  <td>{outgoing.length}</td>
                  <td className="small muted">{n.description}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="small muted">
          注意：外部气象复核 CE-13 是“暴雨导致进水”唯一的反驳证据，但其仅记录接收时间、链路延迟未知，
          系统保留其 16:30–18:30 区间，<b>不据此把该主张判为反驳</b>（稳健性台同样不得用此点证据排除假设）。
        </p>
      </div>

      <div className="card">
        <h3>逐条主张评分（点击行展开簇合并明细与缺证反证）</h3>
        <table>
          <thead>
            <tr>
              <th>主张（边）</th><th>支持量</th><th>反驳量</th><th>无法判定区间</th>
              <th style={{ minWidth: 200 }}>量值对比</th><th>结论</th><th></th>
            </tr>
          </thead>
          <tbody>
            {scores.map((s) => (
              <Fragment key={s.claimId}>
                <tr style={{ cursor: 'pointer' }} onClick={() => setOpenClaim(openClaim === s.claimId ? '' : s.claimId)}>
                  <td className="small">
                    {s.edgeLabel}
                    {s.preconditionFailed && <div className="badge minor" style={{ marginTop: 3 }}>前提失效·停用</div>}
                    <div className="mono muted">{s.claimId}</div>
                  </td>
                  <td className="diff-add">{s.support}</td>
                  <td className="diff-del">{s.refute}</td>
                  <td className="mono small">[{s.unknownRange.low}, {s.unknownRange.high}]</td>
                  <td><RangeBar score={s} /></td>
                  <td><span className={`badge ${VERDICT_BADGE[s.verdict]}`}>{verdictLabel(s.verdict)}</span></td>
                  <td className="small muted">{openClaim === s.claimId ? '收起▲' : '展开▼'}</td>
                </tr>
                {openClaim === s.claimId && (
                  <tr>
                    <td colSpan={7}>
                      <div className="grid-2">
                        <div>
                          <h4 className="small">簇贡献（同簇已合并，不叠加）</h4>
                          {s.clusterContributions.length === 0 && <p className="small muted">无直接关联证据。</p>}
                          <table>
                            <thead><tr><th>簇</th><th>合并极性</th><th>权重</th><th>证据</th><th>说明</th></tr></thead>
                            <tbody>
                              {s.clusterContributions.map((c) => (
                                <tr key={c.clusterId}>
                                  <td className="mono small">{c.clusterId}</td>
                                  <td className="small">{c.mergedPolarity === 'support' ? '支持' : c.mergedPolarity === 'refute' ? '反驳' : c.mergedPolarity === 'conflict' ? '簇内冲突' : '中性'}</td>
                                  <td className="mono">{c.weight}</td>
                                  <td className="mono small">{c.evidenceIds.join(', ')}</td>
                                  <td className="small muted">{c.detail}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                          <p className="small muted">可靠度权重表：高 {RELIABILITY_WEIGHT.high} / 中 {RELIABILITY_WEIGHT.medium} / 低 {RELIABILITY_WEIGHT.low}；共链路簇封顶 0.6。</p>
                        </div>
                        <div>
                          <h4 className="small">缺证反证与计算依据</h4>
                          {s.missingCounterEvidence.length === 0 ? (
                            <p className="small muted">无缺失的应有反证。</p>
                          ) : (
                            <ul className="tight">
                              {s.missingCounterEvidence.map((m, i) => (
                                <li key={i} className="small">
                                  <span className="mono">{m.observableKey}</span>：{m.reason}
                                </li>
                              ))}
                            </ul>
                          )}
                          <p className="small">{s.rationale}</p>
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
