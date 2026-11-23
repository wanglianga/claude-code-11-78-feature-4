// ============================================================
// 推断版本管理：
//  - 维修结论改变某条边的适用条件时，生成新的推断版本（永不覆盖旧版）；
//  - 每个版本固化当时的完整因果图快照与证据范围（证据 ID + 时间容差）；
//  - 处置理由冻结引用某一版本；冻结后该版本只读，历史理由始终可溯源到
//    当时的图与证据范围。
// ============================================================

import type {
  CausalEvidence,
  CausalGraph,
  DisposalRationale,
  InferenceVersion,
  ClaimScore,
  ClaimVerdict,
} from './types';
import type { MaintenanceChangeSet } from './causalScenario';

/** 深拷贝（图均为可结构化克隆的普通对象） */
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** 创建 v1：专家图首次入库时的推断版本 */
export function createInitialVersion(input: {
  graph: CausalGraph;
  evidence: CausalEvidence[];
  toleranceMin: number;
  createdAt: string;
}): InferenceVersion {
  return {
    id: 'IV-v1',
    versionNo: 1,
    createdAt: input.createdAt,
    reason: '专家因果图首次发布，建立基线推断版本',
    triggeredByEvidenceId: null,
    changes: ['基线版本：固化专家图与全部在窗证据范围'],
    graphSnapshot: clone(input.graph),
    evidenceScope: {
      evidenceIds: input.evidence.map((e) => e.id),
      toleranceMin: input.toleranceMin,
    },
    parentVersionId: null,
    frozen: false,
  };
}

/** 应用维修结论变更集，得到新图（不改写原图） */
export function applyMaintenanceChange(
  graph: CausalGraph,
  changeSet: MaintenanceChangeSet,
): CausalGraph {
  const next = clone(graph);
  for (const u of changeSet.nodeUpdates) {
    const node = next.nodes.find((n) => n.id === u.id);
    if (node) node.holds = u.holds;
  }
  for (const eid of changeSet.edgeDisableIds) {
    const edge = next.edges.find((e) => e.id === eid);
    if (edge) edge.enabled = false;
  }
  for (const added of changeSet.edgeAdds) {
    if (!next.edges.some((e) => e.id === added.id)) next.edges.push(clone(added));
  }
  return next;
}

/**
 * 生成下一推断版本。
 * 前置：父版本若已冻结，仍允许“新增”版本（冻结的是旧版本本身，不是推断链）。
 */
export function createNextVersion(input: {
  parent: InferenceVersion;
  newGraph: CausalGraph;
  evidence: CausalEvidence[];
  toleranceMin: number;
  changeSet: MaintenanceChangeSet;
  createdAt: string;
}): InferenceVersion {
  const versionNo = input.parent.versionNo + 1;
  return {
    id: `IV-v${versionNo}`,
    versionNo,
    createdAt: input.createdAt,
    reason: input.changeSet.reason,
    triggeredByEvidenceId: input.changeSet.triggeredByEvidenceId,
    changes: [...input.changeSet.changes],
    graphSnapshot: clone(input.newGraph),
    evidenceScope: {
      evidenceIds: input.evidence.map((e) => e.id),
      toleranceMin: input.toleranceMin,
    },
    parentVersionId: input.parent.id,
    frozen: false,
  };
}

/**
 * 冻结处置理由：把当时的版本与主张结论摘要固化进理由，
 * 并返回需要置为 frozen 的版本 ID（由仓储层拒绝后续改写）。
 */
export function freezeRationale(input: {
  version: InferenceVersion;
  eventRef: string;
  rootCauseId: string;
  rootCauseLabel: string;
  verdict: ClaimVerdict;
  comment: string;
  createdAt: string;
  scores: ClaimScore[];
}): { rationale: DisposalRationale; freezeVersionId: string } {
  const rationale: DisposalRationale = {
    id: `DR-${input.eventRef}-v${input.version.versionNo}`,
    eventRef: input.eventRef,
    rootCauseId: input.rootCauseId,
    rootCauseLabel: input.rootCauseLabel,
    verdict: input.verdict,
    comment: input.comment,
    createdAt: input.createdAt,
    inferenceVersionId: input.version.id,
    versionNo: input.version.versionNo,
    frozenClaimSummary: input.scores.map((s) => ({
      claimId: s.claimId,
      edgeLabel: s.edgeLabel,
      verdict: s.verdict,
    })),
  };
  return { rationale, freezeVersionId: input.version.id };
}

/** 断言版本不可变：编辑页修改图时只能基于最新未冻结版本操作 */
export function assertVersionEditable(version: InferenceVersion): void {
  if (version.frozen) {
    throw new Error(
      `版本 ${version.id} 已被处置理由冻结，不能在原版本上修改；请基于最新版本派生新版本。`,
    );
  }
}
