import { useMemo, useState } from 'react';
import { useCausal } from '../../state/causal';
import { ANALYSIS_WINDOW } from '../../core/causal/causalScenario';
import {
  propagateMissingEvidence,
  scoreClaims,
  epistemicLabel,
} from '../../core/causal/causalEngine';
import type { EpistemicState } from '../../core/causal/types';

const RECOVERED_AT = '2026-07-15T16:20:00+08:00';

const STATE_BADGE: Record<EpistemicState, string> = {
  confirmed: 'ok',
  refuted: 'bad',
  no_counter: 'neutral',
  unknown: 'minor',
};

export default function MissingEvidencePage() {
  const { ready, graph, evidence, clusters, toleranceMin, seed } = useCausal();
  // 视角切换：故障期内（缺证降未知） vs 排水恢复后（缺证转反证）
  const [afterRecovery, setAfterRecovery] = useState(true);

  const { scores, propagation } = useMemo(() => {
    if (!graph) return { scores: [], propagation: null };
    const opts = {
      window: { start: ANALYSIS_WINDOW.start, end: ANALYSIS_WINDOW.end },
      toleranceMin,
      recoveredAt: afterRecovery ? RECOVERED_AT : undefined,
    };
    const s = scoreClaims(graph, evidence, clusters, opts);
    const p = propagateMissingEvidence(graph, evidence, s, opts);
    return { scores: s, propagation: p };
  }, [graph, evidence, clusters, toleranceMin, afterRecovery]);

  if (ready && !graph) {
    return (
      <div className="card">
        <h2>⑬ 缺证传播器</h2>
        <p className="muted small">尚未装载样例。</p>
        <button className="primary" onClick={() => void seed()}>装载汛期因果样例</button>
      </div>
    );
  }
  if (!graph || !propagation) return <div className="card">加载中…</div>;

  return (
    <div>
      <div className="card">
        <h2>⑬ 缺证传播器：沿因果图把“无反证”降为“未知”，并区分缺证反证</h2>
        <p className="muted small">
          上游通道故障（供电中断 / 网关回传失败）会屏蔽其下游可观测项；故障期内相关主张不能视为“无反证”，
          一律降为<b>未知</b>。排水恢复后仍缺失的观测（如传感器未恢复上报）与反向观测（浓度持续升高），
          则是假设成立时<b>本应出现却没有出现</b>的缺证反证。
        </p>
        <div className="tabs">
          <button className={afterRecovery ? 'active' : ''} onClick={() => setAfterRecovery(true)}>
            排水恢复后视角（16:20 起，缺证转反证）
          </button>
          <button className={!afterRecovery ? 'active' : ''} onClick={() => setAfterRecovery(false)}>
            通道故障期视角（14:40–16:20，缺证降未知）
          </button>
        </div>
      </div>

      <div className="card">
        <h3>失效通道与被屏蔽观测</h3>
        <table>
          <thead><tr><th>故障机制节点</th><th>屏蔽的可观测键</th><th>影响</th></tr></thead>
          <tbody>
            {propagation.channelFailures.map((f) => (
              <tr key={f.nodeId}>
                <td><strong>{f.label}</strong><div className="mono small muted">{f.nodeId}</div></td>
                <td className="mono small">{f.blocked.join('、')}</td>
                <td className="small">该通道上的缺报/延迟不再能作为独立证据，也不能按“无反证”处理</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="banner warn" style={{ marginTop: 10 }}>
          强制规则：雨量站与网关共用配电箱 A 且 14:40 同时失联 → 二者归为同一依赖簇 CL-BOX-A，
          计算器不把多条失联记录叠加为“暴雨”的双重支持（见⑪/⑫页簇合并明细）。
        </div>
      </div>

      <div className="card">
        <h3>主张认识状态传播（前 → 后）</h3>
        <table>
          <thead>
            <tr><th>主张</th><th>传播前</th><th></th><th>传播后</th><th>故障通道</th><th>被屏蔽观测</th><th>缺证性质区分</th></tr>
          </thead>
          <tbody>
            {propagation.items.map((it) => (
              <tr key={it.claimId}>
                <td className="small">
                  {it.edgeLabel}
                  <div className="mono muted">{it.claimId}</div>
                </td>
                <td><span className={`badge ${STATE_BADGE[it.before]}`}>{epistemicLabel(it.before)}</span></td>
                <td>→</td>
                <td><span className={`badge ${STATE_BADGE[it.after]}`}>{epistemicLabel(it.after)}</span></td>
                <td className="small mono">{it.blockedBy.join('、') || '—'}</td>
                <td className="small mono">{it.blockedObservables.join('、') || '—'}</td>
                <td className="small" style={{ maxWidth: 360 }}>
                  {it.missingCounterEvidence.length === 0 ? (
                    <span className="muted">无缺失反证</span>
                  ) : (
                    <ul className="tight">
                      {it.missingCounterEvidence.map((m, i) => (
                        <li key={i}>
                          <span className="mono">{m.observableKey}</span>
                          <div className={m.reason.startsWith('通道正常') || m.reason.includes('恢复') ? 'diff-del' : 'muted'}>
                            {m.reason}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="muted">{it.explanation}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3>下游安全判断的不确定性传导</h3>
        {propagation.impactedJudgements.map((j) => (
          <div
            key={j.nodeId}
            className={`banner ${j.state === 'refuted' ? 'bad' : j.state === 'unknown' ? 'warn' : 'ok'}`}
            style={{ marginBottom: 8 }}
          >
            <strong>{j.label}</strong>（{j.nodeId}）：
            <span className={`badge ${STATE_BADGE[j.state]}`} style={{ margin: '0 6px' }}>
              {epistemicLabel(j.state)}
            </span>
            {j.reason}
          </div>
        ))}
        <div className="banner bad">
          关键传导：现场排水完成（16:20）且供电恢复后，浓度 16:30–17:30 仍由 18%LEL 持续升至 41%LEL，
          通道已恢复正常 → “仅积水导致异常（H-WATER-ONLY）”由无反证/支持<b>转为受反驳</b>，
          不确定性沿 CL-HWO-SAFETY 传导至“恢复供气”安全判断：禁止按仅积水假设恢复供气。
        </div>
      </div>

      <div className="card">
        <h3>当前视角下的主张评分对照</h3>
        <table>
          <thead><tr><th>主张</th><th>支持量</th><th>反驳量</th><th>未知区间</th><th>结论</th></tr></thead>
          <tbody>
            {scores.map((s) => (
              <tr key={s.claimId}>
                <td className="small">{s.edgeLabel}</td>
                <td className="diff-add">{s.support}</td>
                <td className="diff-del">{s.refute}</td>
                <td className="mono small">[{s.unknownRange.low}, {s.unknownRange.high}]</td>
                <td>
                  <span className={`badge ${s.verdict === 'support' ? 'ok' : s.verdict === 'refute' ? 'bad' : 'neutral'}`}>
                    {s.verdict === 'support' ? '支持' : s.verdict === 'refute' ? '反驳' : '证据不足'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
