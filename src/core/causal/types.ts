// ============================================================
// 因果推断领域模型：专家因果图 / 证据语义标注 / 依赖簇 /
// 支持-反驳区间计算 / 缺证传播 / 推断版本与冻结快照
//
// 设计原则：
// 1. 结论只能表述为 支持 / 反驳 / 证据不足，最高分仅为待验证解释；
// 2. 同一依赖簇（如雨量站与网关共用配电箱同时失联）的证据先簇内
//    合并，再按簇计入主张，绝不叠加为多重独立佐证；
// 3. 证据时间以区间表示（采样时间未知时仅保留接收时间与延迟上界）；
// 4. 上游通道故障会沿图把下游主张由“无反证”降为“未知”，并区分
//    “假设成立时本应出现却缺失”的可观测反证（缺证反证）。
// ============================================================

// ---------------- 因果图 ----------------

/** 根因（可被裁定的候选解释） */
export type CausalNodeKind = 'root_cause' | 'mechanism' | 'symptom' | 'precondition' | 'impact';

export interface CausalNode {
  id: string;
  kind: CausalNodeKind;
  label: string;
  description: string;
  /** 该节点可观测时所代表的观测语义键，症状/影响节点使用 */
  observableKey?: string;
  /** 节点失效/不成立时会屏蔽哪些观测键（通道故障传播用） */
  blocksObservables?: string[];
  /** 初始是否成立（前置条件节点使用，可被维修结论改写） */
  holds?: boolean;
}

/**
 * 因果边 = 一条可独立检验的主张。
 * 例：“暴雨导致进水”（storm→flooding）与“进水导致供电中断”
 * （flooding→power_loss）是两段分别检验的主张。
 */
export interface CausalEdge {
  id: string;
  from: string;
  to: string;
  label: string;
  /** 适用前提节点 ID 列表；前提不成立时该边不可用（维修结论可改写） */
  preconditionIds: string[];
  /** 假设该边成立时，本应出现的可观测反证键（缺失即构成缺证反证） */
  expectedCounterObservables: string[];
  enabled: boolean;
}

export interface CausalGraph {
  id: string;
  name: string;
  description: string;
  nodes: CausalNode[];
  edges: CausalEdge[];
}

// ---------------- 证据语义标注 ----------------

export type EvidenceKind =
  | 'rainfall' // 雨量站读数
  | 'power' // 供电监测
  | 'gateway_heartbeat' // 网关心跳
  | 'drainage' // 现场排水
  | 'concentration' // 浓度读数
  | 'work_order' // 整改工单
  | 'maintenance' // 后补维修结论
  | 'water_level' // 井内水位/进水观测
  | 'sensor_status'; // 传感器状态/进水失效

export type Reliability = 'high' | 'medium' | 'low';

/** 证据对主张的极性 */
export type EvidencePolarity = 'support' | 'refute' | 'neutral';

export interface TimeInterval {
  /** 区间起点（已知采样时间时等于终点） */
  start: string;
  /** 区间终点；仅知接收时间且链路延迟未知时，终点=接收时间，起点为延迟上界 */
  end: string;
  /** true 表示只记录了接收时间，真实发生时间在 [start,end] 内不可定位 */
  receiveOnly: boolean;
  delayUnknown: boolean;
  note: string;
}

export interface CausalEvidence {
  id: string;
  kind: EvidenceKind;
  label: string;
  source: string;
  /** 来源可靠度 */
  reliability: Reliability;
  /** 依赖簇 ID：同簇证据同源，合并后只能计一次 */
  clusterId: string;
  interval: TimeInterval;
  observableKey: string;
  polarity: EvidencePolarity;
  /** 该证据支持或反驳的主张（边）ID；neutral 时可为空 */
  claimId?: string;
  detail: string;
  /** 证据是否因上游通道故障而不可得（缺证标注，非真实观测） */
  missing: boolean;
}

/** 依赖簇：共享同一失效链路的来源（如同配电箱的雨量站+网关） */
export interface DependencyCluster {
  id: string;
  name: string;
  description: string;
  /** 簇内来源 ID（证据 source 字段） */
  sources: string[];
  /** 簇整体可靠性上限：簇内任一来源失效，整簇降为该等级 */
  sharedFailure: boolean;
}

// ---------------- 计算结果 ----------------

export type ClaimVerdict = 'support' | 'refute' | 'insufficient';

/** 簇内合并后的单簇贡献 */
export interface ClusterContribution {
  clusterId: string;
  evidenceIds: string[];
  /** 合并极性：簇内同时存在支持与反驳时记冲突，取可靠度更高者并标注 */
  mergedPolarity: EvidencePolarity | 'conflict';
  /** 簇可靠度（取簇内最低，且受簇失效上界约束） */
  weight: number;
  detail: string;
}

/** 单条主张的区间似然结果 */
export interface ClaimScore {
  claimId: string;
  edgeLabel: string;
  from: string;
  to: string;
  /** 支持量（按簇合并后的权重和） */
  support: number;
  /** 反驳量 */
  refute: number;
  /** 无法判定的可能范围下界~上界（未知/缺证贡献落入此区间） */
  unknownRange: { low: number; high: number };
  verdict: ClaimVerdict;
  clusterContributions: ClusterContribution[];
  /** 被前置条件停用 */
  preconditionFailed: boolean;
  /** 缺证反证：假设成立本应出现却缺失的观测 */
  missingCounterEvidence: { observableKey: string; reason: string }[];
  rationale: string;
}

/** 缺证传播结果中的节点/主张状态 */
export type EpistemicState = 'confirmed' | 'refuted' | 'no_counter' | 'unknown';

export interface PropagationItem {
  claimId: string;
  edgeLabel: string;
  /** 传播前状态 */
  before: EpistemicState;
  /** 传播后状态 */
  after: EpistemicState;
  /** 导致降级的上游通道 */
  blockedBy: string[];
  /** 被屏蔽的可观测键 */
  blockedObservables: string[];
  missingCounterEvidence: { observableKey: string; reason: string }[];
  explanation: string;
}

export interface PropagationResult {
  /** 通道故障节点 ID 及其屏蔽的观测 */
  channelFailures: { nodeId: string; label: string; blocked: string[] }[];
  items: PropagationItem[];
  /** 受不确定性传导的下游安全判断（impact 节点） */
  impactedJudgements: { nodeId: string; label: string; state: EpistemicState; reason: string }[];
}

// ---------------- 稳健性台 ----------------

export type RobustnessScenarioType =
  | 'baseline'
  | 'drop_cluster' // 删除某个来源簇
  | 'widen_tolerance' // 扩大时间容差
  | 'reliability_shift'; // 替换来源可靠度

export interface RobustnessScenario {
  id: string;
  type: RobustnessScenarioType;
  name: string;
  /** drop_cluster 时的簇 ID */
  clusterId?: string;
  /** widen_tolerance 时扩大的分钟数 */
  extraToleranceMin?: number;
  /** reliability_shift 时的可靠度覆盖 */
  reliabilityOverride?: Record<string, Reliability>;
}

export interface RootCauseRobustnessRow {
  rootCauseId: string;
  rootCauseLabel: string;
  baseline: ClaimVerdict;
  scenarios: { scenarioId: string; verdict: ClaimVerdict; flipped: boolean; note: string }[];
  /** 翻转次数 */
  flipCount: number;
  robust: boolean;
}

// ---------------- 推断版本与冻结快照 ----------------

export interface InferenceVersion {
  id: string;
  versionNo: number;
  createdAt: string;
  reason: string;
  /** 触发新版本的维修结论证据 ID */
  triggeredByEvidenceId: string | null;
  /** 变更说明：哪条边的适用条件被改写 */
  changes: string[];
  /** 版本创建时的完整图快照 */
  graphSnapshot: CausalGraph;
  /** 版本创建时的证据范围（证据 ID 列表 + 时间容差） */
  evidenceScope: { evidenceIds: string[]; toleranceMin: number };
  parentVersionId: string | null;
  frozen: boolean;
}

/** 处置理由：冻结引用当时的图与证据范围 */
export interface DisposalRationale {
  id: string;
  eventRef: string;
  rootCauseId: string;
  rootCauseLabel: string;
  verdict: ClaimVerdict;
  comment: string;
  createdAt: string;
  /** 冻结的推断版本 ID；该版本后续不可改写 */
  inferenceVersionId: string;
  /** 冗余固化的版本号，防止版本被误删后失去溯源 */
  versionNo: number;
  /** 冻结时刻的主张结论摘要 */
  frozenClaimSummary: { claimId: string; edgeLabel: string; verdict: ClaimVerdict }[];
}
