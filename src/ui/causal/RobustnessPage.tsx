import { useMemo } from 'react';
import { useCausal } from '../../state/causal';
import { ANALYSIS_WINDOW } from '../../core/causal/causalScenario';
import {
  DEFAULT_SCENARIOS,
  robustnessAnalysis,
  verdictLabel,
} from '../../core/causal/causalEngine';
import type { ClaimVerdict } from '../../core/causal/types';

const RECOVERED_AT = '2026-07-15T16:20:00+08:00';

const VERDICT_CLS: Record<ClaimVerdict, string> = {
  support: 'ok',
  refute: 'bad',
  insufficient: 'neutral',
};

export default function RobustnessPage() {
  const { ready, graph, evidence, clusters, toleranceMin, seed } = useCausal();

  const rows = useMemo(() => {
    if (!graph) return [];
    return robustnessAnalysis(
      graph,
      evidence,
      clusters,
      {
        window: { start: ANALYSIS_WINDOW.start, end: ANALYSIS_WINDOW.end },
        toleranceMin,
        recoveredAt: RECOVERED_AT,
      },
      DEFAULT_SCENARIOS,
    );
  }, [graph, evidence, clusters, toleranceMin]);

  const scenarioName = useMemo(() => {
    const m = new Map(DEFAULT_SCENARIOS.map((s) => [s.id, s.name]));
    return m;
  }, []);

  if (ready && !graph) {
    return (
      <div className="card">
        <h2>⑭ 结论稳健性台</h2>
        <p className="muted small">尚未装载样例。</p>
        <button className="primary" onClick={() => void seed()}>装载汛期因果样例</button>
      </div>
    );
  }
  if (!graph) return <div className="card">加载中…</div>;

  const totalFlips = rows.reduce((n, r) => n + r.flipCount, 0);

  return (
    <div>
      <div className="card">
        <h2>⑭ 结论稳健性台：删来源簇 / 扩时间容差 / 替换可靠度后的根因翻转</h2>
        <p className="muted small">
          对每个候选根因比较基线与各扰动情景下的结论。翻转越多，结论越脆弱；
          无论得分高低，结论只表述为<b>支持 / 反驳 / 证据不足</b>，最高分仅为待验证解释。
        </p>
        <div className="kpi-grid">
          <div className="kpi"><div className="num">{rows.length}</div><div className="label">候选根因数</div></div>
          <div className="kpi"><div className="num">{totalFlips}</div><div className="label">全部情景中的翻转次数</div></div>
          <div className="kpi"><div className="num">{rows.filter((r) => r.robust).length}</div><div className="label">稳健根因数（零翻转）</div></div>
          <div className="kpi"><div className="num">{DEFAULT_SCENARIOS.length - 1}</div><div className="label">扰动情景数</div></div>
        </div>
      </div>

      <div className="card">
        <h3>根因 × 情景翻转矩阵</h3>
        <div style={{ overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>候选根因</th>
                {DEFAULT_SCENARIOS.map((s) => (
                  <th key={s.id} style={{ minWidth: 130 }}>
                    <div className="small">{s.name}</div>
                    <div className="mono muted">{s.id}</div>
                  </th>
                ))}
                <th>翻转数</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.rootCauseId}>
                  <td>
                    <strong>{r.rootCauseLabel}</strong>
                    <div className="mono small muted">{r.rootCauseId}</div>
                    <span className={`badge ${VERDICT_CLS[r.baseline]}`}>基线：{verdictLabel(r.baseline)}</span>
                  </td>
                  {r.scenarios.map((sc) => (
                    <td key={sc.scenarioId} style={sc.flipped ? { background: '#fde7e3' } : undefined}>
                      <span className={`badge ${VERDICT_CLS[sc.verdict]}`}>{verdictLabel(sc.verdict)}</span>
                      {sc.flipped && <div className="small diff-del">⇅ 翻转</div>}
                    </td>
                  ))}
                  <td>
                    <strong className={r.flipCount === 0 ? 'diff-add' : 'diff-del'}>{r.flipCount}</strong>
                    <div className="small muted">{r.robust ? '稳健' : '脆弱'}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h3>逐根因翻转说明</h3>
        {rows.map((r) => (
          <div key={r.rootCauseId} className="route-box" style={{ marginBottom: 10 }}>
            <h4>
              {r.rootCauseLabel}
              <span className={`badge ${r.robust ? 'ok' : 'bad'}`} style={{ marginLeft: 8 }}>
                {r.robust ? '稳健（无翻转）' : `${r.flipCount} 次翻转`}
              </span>
            </h4>
            <ul className="tight">
              {r.scenarios.filter((s) => s.scenarioId !== 'RB-BASE').map((s) => (
                <li key={s.scenarioId} className="small">
                  {scenarioName.get(s.scenarioId)}：{s.note}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="card">
        <h3>强制规则的稳健性保证</h3>
        <ul className="tight small">
          <li>
            <b>仅接收时间证据（CE-13）</b>：扩大时间容差（+30/+60 分钟）时，系统按整段区间 16:30–18:30 判定，
            区间始终与分析窗相交，<b>不会被时间窗剔除</b>；同时因其链路延迟未知，任何情景下都不能仅凭该点证据
            把“暴雨导致进水”排除（结论最多降为证据不足）。
          </li>
          <li>
            <b>删除配电箱 A 簇</b>：暴雨主张失去 CL-BOX-A 簇贡献后，仍有独立传感器簇 CL-SENSOR 的井内水位记录（CE-05）支撑，
            用于检验结论是否依赖单一共链路来源。
          </li>
          <li>
            <b>可靠度替换</b>：共链路簇整体下调与外部气象来源提权分别检验“来源可靠度敏感性”，
            共链路簇因共享失效，权重本身已被封顶 0.6。
          </li>
          <li>
            <b>删除井场传感器簇</b>：浓度升高证据 CE-08/CE-09 同时消失，“仅积水”假设的反驳与泄漏假设的支持均回落，
            体现结论对关键独立来源的依赖程度。
          </li>
        </ul>
      </div>
    </div>
  );
}
