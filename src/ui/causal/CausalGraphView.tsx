// ============================================================
// 因果图 SVG 视图：确定性分层布局（不引入第三方图库）。
// 列：前置条件 → 候选根因 → 机制 → 可观测征兆 → 下游影响。
// 可选叠加主张结论着色、通道故障高亮与停用边虚线。
// ============================================================

import type { CausalGraph, CausalNode, ClaimVerdict } from '../../core/causal/types';

const KIND_COL: Record<CausalNode['kind'], number> = {
  precondition: 40,
  root_cause: 250,
  mechanism: 480,
  symptom: 730,
  impact: 980,
};

const KIND_COLOR: Record<CausalNode['kind'], string> = {
  root_cause: '#b42318',
  mechanism: '#b25e09',
  symptom: '#175cd3',
  precondition: '#5b3db8',
  impact: '#1a7f4b',
};

const KIND_LABEL: Record<CausalNode['kind'], string> = {
  root_cause: '根因',
  mechanism: '机制',
  symptom: '征兆',
  precondition: '前提',
  impact: '影响',
};

const VERDICT_COLOR: Record<ClaimVerdict, string> = {
  support: '#1a7f4b',
  refute: '#b42318',
  insufficient: '#667085',
};

export function layoutGraph(graph: CausalGraph): Map<string, { x: number; y: number }> {
  const cols = new Map<CausalNode['kind'], CausalNode[]>();
  for (const n of graph.nodes) {
    cols.set(n.kind, [...(cols.get(n.kind) ?? []), n]);
  }
  const pos = new Map<string, { x: number; y: number }>();
  for (const [kind, ns] of cols) {
    const step = Math.min(110, 560 / Math.max(1, ns.length));
    ns.forEach((n, i) => pos.set(n.id, { x: KIND_COL[kind], y: 60 + i * (step + 26) }));
  }
  return pos;
}

export default function CausalGraphView(props: {
  graph: CausalGraph;
  verdicts?: Map<string, ClaimVerdict>;
  failedNodeIds?: Set<string>;
  height?: number;
}) {
  const { graph, verdicts, failedNodeIds = new Set(), height = 620 } = props;
  const pos = layoutGraph(graph);

  return (
    <svg className="ev-graph" viewBox="0 0 1200 620" style={{ height }}>
      <defs>
        <marker id="cg-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill="#8aa0b5" />
        </marker>
      </defs>
      {graph.edges.map((e) => {
        const a = pos.get(e.from);
        const b = pos.get(e.to);
        if (!a || !b) return null;
        const mx = (a.x + b.x) / 2;
        const verdict = verdicts?.get(e.id);
        const color = !e.enabled ? '#b0b8c2' : verdict ? VERDICT_COLOR[verdict] : '#8aa0b5';
        return (
          <g key={e.id} className="ev-edge">
            <path
              d={`M${a.x + 96},${a.y} C${mx},${a.y} ${mx},${b.y} ${b.x - 8},${b.y}`}
              markerEnd="url(#cg-arrow)"
              stroke={color}
              strokeDasharray={!e.enabled ? '5 4' : undefined}
            />
            <text x={mx} y={(a.y + b.y) / 2 - 6} textAnchor="middle" fill={color}>
              {e.label}
              {verdict ? `（${verdict === 'support' ? '支持' : verdict === 'refute' ? '反驳' : '不足'}）` : ''}
            </text>
          </g>
        );
      })}
      {graph.nodes.map((n) => {
        const p = pos.get(n.id)!;
        const failed = failedNodeIds.has(n.id);
        const color = KIND_COLOR[n.kind];
        return (
          <g key={n.id} className="ev-node" transform={`translate(${p.x - 98},${p.y - 24})`}>
            <rect
              width={196}
              height={48}
              rx={8}
              fill={failed ? '#fde7e3' : '#fff'}
              stroke={failed ? '#b42318' : color}
              strokeWidth={failed ? 2.4 : 1.5}
            />
            <circle cx={12} cy={15} r={6} fill={color} />
            <text x={26} y={18} fontWeight={600}>
              {n.label}
              {n.kind === 'precondition' && n.holds === false ? '（前提失效）' : ''}
              {failed ? ' ⚠通道故障' : ''}
            </text>
            <text x={26} y={35} fill="#667085">
              {KIND_LABEL[n.kind]} · {n.id}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
