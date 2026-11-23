// ============================================================
// 因果推断仓储层：图 / 证据标注册 / 依赖簇 / 推断版本 / 处置理由
// 全部落 IndexedDB，离线可用；冻结版本只允许新增、不允许覆盖。
// ============================================================

import { STORES, getAll, getOne, putOne, putMany, clearStore } from '../db';
import type {
  CausalEvidence,
  CausalGraph,
  DependencyCluster,
  DisposalRationale,
  InferenceVersion,
} from './types';

export const causalRepository = {
  // ---------- 图 ----------
  graph: () => getOne<CausalGraph>(STORES.causalGraph, 'CG-FLOOD-1'),
  saveGraph: (g: CausalGraph) => putOne(STORES.causalGraph, g),

  // ---------- 证据 ----------
  evidence: () => getAll<CausalEvidence>(STORES.causalEvidence),
  saveEvidence: (rows: CausalEvidence[]) => putMany(STORES.causalEvidence, rows),

  // ---------- 依赖簇 ----------
  clusters: () => getAll<DependencyCluster>(STORES.causalClusters),
  saveClusters: (rows: DependencyCluster[]) => putMany(STORES.causalClusters, rows),

  // ---------- 推断版本 ----------
  versions: () => getAll<InferenceVersion>(STORES.causalVersions),
  /** 冻结版本不可覆盖：若已存在同号冻结版本则拒绝 */
  addVersion: async (v: InferenceVersion) => {
    const existing = await getOne<InferenceVersion>(STORES.causalVersions, v.id);
    if (existing?.frozen) {
      throw new Error(`推断版本 ${v.id} 已冻结，不能改写（处置理由仍引用当时的图与证据范围）`);
    }
    return putOne(STORES.causalVersions, v);
  },
  freezeVersion: async (id: string) => {
    const v = await getOne<InferenceVersion>(STORES.causalVersions, id);
    if (!v) throw new Error(`推断版本 ${id} 不存在`);
    return putOne(STORES.causalVersions, { ...v, frozen: true });
  },

  // ---------- 处置理由（冻结引用） ----------
  rationales: () => getAll<DisposalRationale>(STORES.causalRationale),
  addRationale: (r: DisposalRationale) => putOne(STORES.causalRationale, r),

  /** 重置因果子系统（不动核验底座数据） */
  resetCausal: () =>
    Promise.all(
      [
        STORES.causalGraph,
        STORES.causalEvidence,
        STORES.causalClusters,
        STORES.causalVersions,
        STORES.causalRationale,
      ].map(clearStore),
    ),
};
