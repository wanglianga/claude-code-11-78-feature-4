import { useMemo, useState } from 'react';
import { useCausal } from '../../state/causal';
import type { CausalEdge, CausalNode, CausalNodeKind } from '../../core/causal/types';
import CausalGraphView from './CausalGraphView';

const KIND_OPTIONS: CausalNodeKind[] = ['root_cause', 'mechanism', 'symptom', 'precondition', 'impact'];
const KIND_LABEL: Record<CausalNodeKind, string> = {
  root_cause: '候选根因',
  mechanism: '机制',
  symptom: '可观测征兆',
  precondition: '前置条件',
  impact: '下游影响',
};

export default function CausalEditorPage() {
  const {
    ready, graph, evidence, clusters, versions, rationales,
    seed, saveGraph, applyMaintenance, freezeRationaleFor, reset,
  } = useCausal();

  const [nodeId, setNodeId] = useState('');
  const [nodeLabel, setNodeLabel] = useState('');
  const [nodeKind, setNodeKind] = useState<CausalNodeKind>('symptom');
  const [edgeFrom, setEdgeFrom] = useState('');
  const [edgeTo, setEdgeTo] = useState('');
  const [edgeLabel, setEdgeLabel] = useState('');
  const [edgePre, setEdgePre] = useState<string[]>([]);
  const [edgeCounters, setEdgeCounters] = useState('');
  const [eventRef, setEventRef] = useState('WO-20260715-001');
  const [rootCauseId, setRootCauseId] = useState('H-WATER-ONLY');
  const [comment, setComment] = useState('基于当前推断版本冻结处置理由，保留当时图与证据范围。');

  const latest = versions[versions.length - 1];
  const rootCauses = useMemo(
    () => graph?.nodes.filter((n) => n.kind === 'root_cause') ?? [],
    [graph],
  );

  if (ready && !graph) {
    return (
      <div className="card">
        <h2>⑩ 因果假设图编辑器</h2>
        <p className="muted small">
          尚未装载汛期因果样例。装载后将建立专家因果图、证据语义标注册、依赖簇与推断版本 v1。
        </p>
        <button className="primary" onClick={() => void seed()}>装载汛期因果样例（确定性数据）</button>
      </div>
    );
  }
  if (!graph) return <div className="card">加载中…</div>;

  const addNode = () => {
    if (!nodeId.trim() || graph.nodes.some((n) => n.id === nodeId.trim())) return;
    const node: CausalNode = {
      id: nodeId.trim(), kind: nodeKind, label: nodeLabel.trim() || nodeId.trim(),
      description: '编辑器新增节点', holds: nodeKind === 'precondition' ? true : undefined,
    };
    void saveGraph({ ...graph, nodes: [...graph.nodes, node] }, `编辑器新增节点 ${node.id}`);
    setNodeId('');
    setNodeLabel('');
  };

  const addEdge = () => {
    if (!edgeFrom || !edgeTo || edgeFrom === edgeTo) return;
    const id = `CL-${edgeFrom}-${edgeTo}-${graph.edges.length + 1}`;
    if (graph.edges.some((e) => e.id === id)) return;
    const edge: CausalEdge = {
      id, from: edgeFrom, to: edgeTo, label: edgeLabel || `${edgeFrom} → ${edgeTo}`,
      preconditionIds: edgePre,
      expectedCounterObservables: edgeCounters.split(',').map((s) => s.trim()).filter(Boolean),
      enabled: true,
    };
    void saveGraph({ ...graph, edges: [...graph.edges, edge] }, `编辑器新增主张 ${id}`);
    setEdgeLabel('');
    setEdgePre([]);
    setEdgeCounters('');
  };

  const toggleEdge = (id: string) => {
    const edges = graph.edges.map((e) => (e.id === id ? { ...e, enabled: !e.enabled } : e));
    void saveGraph({ ...graph, edges }, `切换主张 ${id} 启用状态`);
  };

  const togglePrecondition = (id: string) => {
    const nodes = graph.nodes.map((n) =>
      n.id === id && n.kind === 'precondition' ? { ...n, holds: !n.holds } : n,
    );
    void saveGraph({ ...graph, nodes }, `改写前置条件 ${id} 成立状态`);
  };

  const removeNode = (id: string) => {
    // 被边连接、或被任何边的适用前提引用的节点都不允许删除，避免悬挂引用
    const referenced = graph.edges.some(
      (e) => e.from === id || e.to === id || e.preconditionIds.includes(id),
    );
    if (referenced) return;
    void saveGraph({ ...graph, nodes: graph.nodes.filter((n) => n.id !== id) }, `删除节点 ${id}`);
  };

  const preconditions = graph.nodes.filter((n) => n.kind === 'precondition');

  return (
    <div>
      <div className="card">
        <h2>⑩ 因果假设图编辑器：根因 / 机制 / 征兆 / 前提 / 影响的有向因果图</h2>
        <p className="muted small">
          每条有向边是一条<b>可独立检验的主张</b>（如“暴雨导致进水”与“进水导致供电中断”分开检验）；
          前置条件不成立的边自动停用。修改已冻结版本会自动派生新推断版本，历史快照不被改写。
          当前版本：<span className="mono">{latest?.id}{latest?.frozen ? '（已冻结）' : ''}</span>
        </p>
        <div className="tabs">
          <button className="ghost" onClick={() => void applyMaintenance()}>应用后补维修结论（生成 v2）</button>
          <button className="ghost" onClick={() => void reset()}>重置因果子系统</button>
        </div>
        <CausalGraphView graph={graph} failedNodeIds={new Set(['M-POWER', 'M-GW'])} />
        <div className="legend">
          {KIND_OPTIONS.map((k) => (
            <span key={k} style={{ color: 'var(--ink)' }}>
              <span className="tag">{KIND_LABEL[k]}</span>
            </span>
          ))}
          <span className="small muted">虚线边＝已停用（前提失效或人工停用）；红框节点＝通道故障机制</span>
        </div>
      </div>

      <div className="grid-2">
        <div className="card">
          <h3>新增节点</h3>
          <table>
            <tbody>
              <tr><td>节点 ID</td><td><input value={nodeId} onChange={(e) => setNodeId(e.target.value)} placeholder="如 RC-X" /></td></tr>
              <tr><td>名称</td><td><input value={nodeLabel} onChange={(e) => setNodeLabel(e.target.value)} /></td></tr>
              <tr>
                <td>类型</td>
                <td>
                  <select value={nodeKind} onChange={(e) => setNodeKind(e.target.value as CausalNodeKind)}>
                    {KIND_OPTIONS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
                  </select>
                </td>
              </tr>
            </tbody>
          </table>
          <button className="primary tiny" style={{ marginTop: 8 }} onClick={addNode}>添加节点</button>

          <h3>新增主张边</h3>
          <table>
            <tbody>
              <tr>
                <td>从</td>
                <td>
                  <select value={edgeFrom} onChange={(e) => setEdgeFrom(e.target.value)}>
                    <option value="">选择节点</option>
                    {graph.nodes.map((n) => <option key={n.id} value={n.id}>{n.label}</option>)}
                  </select>
                </td>
              </tr>
              <tr>
                <td>到</td>
                <td>
                  <select value={edgeTo} onChange={(e) => setEdgeTo(e.target.value)}>
                    <option value="">选择节点</option>
                    {graph.nodes.map((n) => <option key={n.id} value={n.id}>{n.label}</option>)}
                  </select>
                </td>
              </tr>
              <tr><td>主张文本</td><td><input value={edgeLabel} onChange={(e) => setEdgeLabel(e.target.value)} /></td></tr>
              <tr>
                <td>适用前提</td>
                <td>
                  <select multiple value={edgePre} onChange={(e) => setEdgePre(Array.from(e.target.selectedOptions).map((o) => o.value))} style={{ height: 70 }}>
                    {preconditions.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                  </select>
                </td>
              </tr>
              <tr><td>应有反证键</td><td><input value={edgeCounters} onChange={(e) => setEdgeCounters(e.target.value)} placeholder="逗号分隔 observableKey" /></td></tr>
            </tbody>
          </table>
          <button className="primary tiny" style={{ marginTop: 8 }} onClick={addEdge}>添加主张边</button>
        </div>

        <div className="card">
          <h3>前置条件切换</h3>
          {preconditions.map((p) => (
            <div key={p.id} style={{ marginBottom: 8 }}>
              <span className="mono small">{p.id}</span> {p.label}
              <span className={`badge ${p.holds ? 'ok' : 'bad'}`} style={{ marginLeft: 8 }}>
                {p.holds ? '成立' : '不成立'}
              </span>
              <button className="ghost tiny" style={{ marginLeft: 8 }} onClick={() => togglePrecondition(p.id)}>切换</button>
            </div>
          ))}

          <h3>主张边清单（{graph.edges.length}）</h3>
          <div style={{ maxHeight: 260, overflow: 'auto' }}>
            <table>
              <thead><tr><th>主张</th><th>前提</th><th>状态</th><th></th></tr></thead>
              <tbody>
                {graph.edges.map((e) => (
                  <tr key={e.id}>
                    <td className="small">{e.label}<div className="mono muted">{e.id}</div></td>
                    <td className="small mono">{e.preconditionIds.join(',') || '—'}</td>
                    <td><span className={`badge ${e.enabled ? 'ok' : 'neutral'}`}>{e.enabled ? '启用' : '停用'}</span></td>
                    <td>
                      <button className="ghost tiny" onClick={() => toggleEdge(e.id)}>切换</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3>孤立节点删除</h3>
          {graph.nodes
            .filter(
              (n) =>
                !graph.edges.some(
                  (e) => e.from === n.id || e.to === n.id || e.preconditionIds.includes(n.id),
                ),
            )
            .map((n) => (
              <span key={n.id} style={{ marginRight: 8 }}>
                <span className="tag">{n.label}</span>
                <button className="danger tiny" onClick={() => removeNode(n.id)}>删</button>
              </span>
            ))}
          {graph.nodes.every((n) =>
            graph.edges.some((e) => e.from === n.id || e.to === n.id || e.preconditionIds.includes(n.id)),
          ) && (
            <span className="small muted">无孤立节点</span>
          )}
        </div>
      </div>

      <div className="card">
        <h3>推断版本链（{versions.length}）</h3>
        <table>
          <thead><tr><th>版本</th><th>创建时间</th><th>触发证据</th><th>变更</th><th>图快照</th><th>证据范围</th><th>状态</th></tr></thead>
          <tbody>
            {versions.map((v) => (
              <tr key={v.id}>
                <td className="mono"><strong>{v.id}</strong><div className="small muted">父版本 {v.parentVersionId ?? '—'}</div></td>
                <td className="small">{v.createdAt.slice(5, 16).replace('T', ' ')}</td>
                <td className="small mono">{v.triggeredByEvidenceId ?? '—'}</td>
                <td className="small">
                  <ul className="tight">{v.changes.map((c, i) => <li key={i}>{c}</li>)}</ul>
                  <div className="muted">{v.reason}</div>
                </td>
                <td className="small">{v.graphSnapshot.nodes.length} 节点 / {v.graphSnapshot.edges.length} 边</td>
                <td className="small">{v.evidenceScope.evidenceIds.length} 条证据 · 容差 {v.evidenceScope.toleranceMin} 分钟</td>
                <td><span className={`badge ${v.frozen ? 'bad' : 'ok'}`}>{v.frozen ? '已冻结' : '可编辑'}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3>冻结处置理由（处置理由持续引用当时的图与证据范围）</h3>
        <div className="grid-3">
          <label className="small">事件编号<br /><input value={eventRef} onChange={(e) => setEventRef(e.target.value)} /></label>
          <label className="small">根因结论<br />
            <select value={rootCauseId} onChange={(e) => setRootCauseId(e.target.value)}>
              {rootCauses.map((n) => <option key={n.id} value={n.id}>{n.label}</option>)}
            </select>
          </label>
          <label className="small">处置意见<br /><input value={comment} onChange={(e) => setComment(e.target.value)} /></label>
        </div>
        <button
          className="primary tiny"
          style={{ marginTop: 8 }}
          onClick={() => void freezeRationaleFor({ eventRef, rootCauseId, comment })}
        >
          冻结当前版本并生成处置理由
        </button>
        {rationales.length > 0 && (
          <table style={{ marginTop: 10 }}>
            <thead><tr><th>理由 ID</th><th>事件</th><th>根因</th><th>结论</th><th>引用版本</th><th>冻结主张数</th></tr></thead>
            <tbody>
              {rationales.map((r) => (
                <tr key={r.id}>
                  <td className="mono small">{r.id}</td>
                  <td className="small">{r.eventRef}</td>
                  <td className="small">{r.rootCauseLabel}</td>
                  <td><span className="badge neutral">{r.verdict === 'support' ? '支持' : r.verdict === 'refute' ? '反驳' : '证据不足'}</span></td>
                  <td className="mono">{r.inferenceVersionId}（v{r.versionNo}）</td>
                  <td>{r.frozenClaimSummary.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="small muted" style={{ marginTop: 8 }}>
          样例已装载：{evidence.length} 条证据、{clusters.length} 个依赖簇。
        </p>
      </div>
    </div>
  );
}
