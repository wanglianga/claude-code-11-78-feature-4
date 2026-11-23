import { useMemo, useState } from 'react';
import { useCausal } from '../../state/causal';
import type { CausalEvidence, EvidenceKind, Reliability } from '../../core/causal/types';
import { RELIABILITY_WEIGHT } from '../../core/causal/causalEngine';

const KIND_LABEL: Record<EvidenceKind, string> = {
  rainfall: '雨量',
  power: '供电',
  gateway_heartbeat: '网关心跳',
  drainage: '现场排水',
  concentration: '浓度',
  work_order: '工单',
  maintenance: '维修结论',
  water_level: '井内水位',
  sensor_status: '传感器状态',
};

const REL_LABEL: Record<Reliability, string> = { high: '高', medium: '中', low: '低' };
const POL_LABEL = { support: '支持', refute: '反驳', neutral: '中性' } as const;

function hm(iso: string) {
  return iso.slice(11, 16);
}

export default function CausalEvidencePage() {
  const { ready, graph, evidence, clusters, seed, saveEvidenceRows } = useCausal();
  const [clusterFilter, setClusterFilter] = useState('');
  const [tab, setTab] = useState<'evidence' | 'cluster'>('evidence');

  const claimLabel = useMemo(() => {
    const m = new Map<string, string>();
    graph?.edges.forEach((e) => m.set(e.id, e.label));
    return m;
  }, [graph]);

  if (ready && !graph) {
    return (
      <div className="card">
        <h2>⑪ 证据语义标注册</h2>
        <p className="muted small">尚未装载样例。</p>
        <button className="primary" onClick={() => void seed()}>装载汛期因果样例</button>
      </div>
    );
  }
  if (!graph) return <div className="card">加载中…</div>;

  const rows = clusterFilter ? evidence.filter((e) => e.clusterId === clusterFilter) : evidence;

  const updateReliability = (id: string, reliability: Reliability) => {
    const next = evidence.map((e) => (e.id === id ? { ...e, reliability } : e));
    void saveEvidenceRows(next);
  };

  return (
    <div>
      <div className="card">
        <h2>⑪ 证据语义标注册：发生区间 · 来源可靠度 · 依赖簇 · 支持/反驳主张</h2>
        <p className="muted small">
          每条证据保留<b>发生时间区间</b>而非单点时间戳；只记录接收时间且链路延迟未知的证据（如 CE-13）整段保留区间，
          任何时间容差情景都不能把它按单点剔除，也不能仅凭它排除假设。
          同依赖簇证据先簇内合并再计入主张（<b>不叠加</b>）。
        </p>
        <div className="tabs">
          <button className={tab === 'evidence' ? 'active' : ''} onClick={() => setTab('evidence')}>证据列表（{evidence.length}）</button>
          <button className={tab === 'cluster' ? 'active' : ''} onClick={() => setTab('cluster')}>依赖簇视图（{clusters.length}）</button>
        </div>
        <label className="small">
          按簇筛选：
          <select value={clusterFilter} onChange={(e) => setClusterFilter(e.target.value)} style={{ marginLeft: 6 }}>
            <option value="">全部</option>
            {clusters.map((c) => <option key={c.id} value={c.id}>{c.name}（{c.id}）</option>)}
          </select>
        </label>
      </div>

      {tab === 'evidence' && (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>ID</th><th>类型</th><th>证据/来源</th><th>发生区间</th><th>可靠度</th>
                <th>依赖簇</th><th>观测键</th><th>极性→主张</th><th>语义说明</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e: CausalEvidence) => (
                <tr key={e.id} style={e.interval.receiveOnly ? { background: '#fff8ec' } : undefined}>
                  <td className="mono small">{e.id}</td>
                  <td><span className="tag">{KIND_LABEL[e.kind]}</span></td>
                  <td className="small">
                    <strong>{e.label}</strong>
                    <div className="muted mono">{e.source}</div>
                  </td>
                  <td className="small mono">
                    {hm(e.interval.start)}–{hm(e.interval.end)}
                    {e.interval.receiveOnly && (
                      <div className="badge minor" style={{ marginTop: 3 }}>仅接收时间·延迟未知</div>
                    )}
                    <div className="muted" style={{ maxWidth: 220 }}>{e.interval.note}</div>
                  </td>
                  <td>
                    <select
                      value={e.reliability}
                      onChange={(ev) => updateReliability(e.id, ev.target.value as Reliability)}
                    >
                      {(['high', 'medium', 'low'] as Reliability[]).map((r) => (
                        <option key={r} value={r}>{REL_LABEL[r]}（{RELIABILITY_WEIGHT[r]}）</option>
                      ))}
                    </select>
                  </td>
                  <td className="small mono">{e.clusterId}</td>
                  <td className="small mono">{e.observableKey}</td>
                  <td className="small">
                    <span className={`badge ${e.polarity === 'support' ? 'ok' : e.polarity === 'refute' ? 'bad' : 'neutral'}`}>
                      {POL_LABEL[e.polarity]}
                    </span>
                    {e.claimId && <div className="muted" style={{ maxWidth: 180 }}>{claimLabel.get(e.claimId) ?? e.claimId}</div>}
                  </td>
                  <td className="small" style={{ maxWidth: 280 }}>{e.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'cluster' && (
        <div>
          {clusters.map((c) => {
            const members = evidence.filter((e) => e.clusterId === c.id);
            return (
              <div className="card" key={c.id}>
                <h3>
                  <span className="mono">{c.id}</span> {c.name}
                  {c.sharedFailure && <span className="badge major" style={{ marginLeft: 8 }}>共链路·权重封顶 0.6</span>}
                </h3>
                <p className="small muted">{c.description}</p>
                <p className="small">
                  簇内来源：{c.sources.join('、')}；成员证据 {members.length} 条，合并后只计 <strong>1</strong> 个簇贡献。
                </p>
                <table>
                  <thead><tr><th>证据</th><th>来源</th><th>区间</th><th>可靠度</th><th>极性</th><th>主张</th></tr></thead>
                  <tbody>
                    {members.map((m) => (
                      <tr key={m.id}>
                        <td className="small">{m.id} {m.label}</td>
                        <td className="small mono">{m.source}</td>
                        <td className="small mono">{hm(m.interval.start)}–{hm(m.interval.end)}{m.interval.receiveOnly ? '（仅接收）' : ''}</td>
                        <td className="small">{REL_LABEL[m.reliability]}</td>
                        <td className="small">{POL_LABEL[m.polarity]}</td>
                        <td className="small">{m.claimId ? claimLabel.get(m.claimId) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })}
          <div className="card">
            <h3>强制规则演示：雨量站 × 网关 × 供电监测同簇</h3>
            <p className="small">
              CE-01（雨量）、CE-02（供电）、CE-03（心跳）、CE-04（供电间接信号）同属 <span className="mono">CL-BOX-A</span>。
              即使 CE-01 与 CE-04 都指向“暴雨导致进水”，计算器也只产生 1 个簇贡献，
              <b>不会叠加成“暴雨”的双重支持</b>；下一页「主张区间」可查看合并明细。
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
