// ============================================================
// 因果推断 React 状态层：图 / 证据 / 簇 / 推断版本 / 冻结处置理由
// 所有写操作落 IndexedDB；组件按版本快照确定性复算，不缓存结论。
// ============================================================

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { causalRepository } from '../core/causal/causalRepository';
import {
  ANALYSIS_WINDOW,
  buildCausalEvidence,
  buildCausalGraph,
  buildClusters,
  buildV2ChangeSet,
} from '../core/causal/causalScenario';
import {
  applyMaintenanceChange,
  createInitialVersion,
  createNextVersion,
  freezeRationale,
} from '../core/causal/causalVersion';
import { rootCauseVerdicts, scoreClaims } from '../core/causal/causalEngine';
import type {
  CausalEvidence,
  CausalGraph,
  DependencyCluster,
  DisposalRationale,
  InferenceVersion,
} from '../core/causal/types';

const SEED_AT = '2026-07-15T18:00:00+08:00';
const MAINT_AT = '2026-07-16T09:30:00+08:00';

interface CausalCtx {
  ready: boolean;
  graph: CausalGraph | null;
  evidence: CausalEvidence[];
  clusters: DependencyCluster[];
  versions: InferenceVersion[];
  rationales: DisposalRationale[];
  toleranceMin: number;
  setToleranceMin: (m: number) => void;
  seed: () => Promise<void>;
  saveGraph: (g: CausalGraph, changeNote: string) => Promise<void>;
  saveEvidenceRows: (rows: CausalEvidence[]) => Promise<void>;
  applyMaintenance: () => Promise<void>;
  freezeRationaleFor: (input: {
    eventRef: string;
    rootCauseId: string;
    comment: string;
  }) => Promise<DisposalRationale | null>;
  reset: () => Promise<void>;
}

const Ctx = createContext<CausalCtx | null>(null);

export function CausalProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [graph, setGraph] = useState<CausalGraph | null>(null);
  const [evidence, setEvidence] = useState<CausalEvidence[]>([]);
  const [clusters, setClusters] = useState<DependencyCluster[]>([]);
  const [versions, setVersions] = useState<InferenceVersion[]>([]);
  const [rationales, setRationales] = useState<DisposalRationale[]>([]);
  const [toleranceMin, setToleranceMin] = useState(ANALYSIS_WINDOW.toleranceMin);

  const refresh = useCallback(async () => {
    const [g, ev, cl, vs, rs] = await Promise.all([
      causalRepository.graph(),
      causalRepository.evidence(),
      causalRepository.clusters(),
      causalRepository.versions(),
      causalRepository.rationales(),
    ]);
    setGraph(g ?? null);
    setEvidence(ev);
    setClusters(cl);
    setVersions(vs.sort((a, b) => a.versionNo - b.versionNo));
    setRationales(rs);
    setReady(true);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const seed = useCallback(async () => {
    const g = buildCausalGraph();
    const ev = buildCausalEvidence();
    const cl = buildClusters();
    const v1 = createInitialVersion({
      graph: g,
      evidence: ev,
      toleranceMin: ANALYSIS_WINDOW.toleranceMin,
      createdAt: SEED_AT,
    });
    await Promise.all([
      causalRepository.saveGraph(g),
      causalRepository.saveEvidence(ev),
      causalRepository.saveClusters(cl),
      causalRepository.addVersion(v1),
    ]);
    await refresh();
  }, [refresh]);

  const saveGraph = useCallback(
    async (next: CausalGraph, changeNote: string) => {
      const latest = [...versions].sort((a, b) => b.versionNo - a.versionNo)[0];
      if (!latest) throw new Error('缺少基线推断版本，请先装载样例');
      // 图的任何修订都派生新版本：版本快照只增不改，保证历史处置理由始终可溯源
      const nv = createNextVersion({
        parent: latest,
        newGraph: next,
        evidence,
        toleranceMin,
        changeSet: {
          triggeredByEvidenceId: null,
          reason: changeNote,
          changes: [changeNote],
          nodeUpdates: [],
          edgeDisableIds: [],
          edgeAdds: [],
        },
        createdAt: MAINT_AT,
      });
      await Promise.all([
        causalRepository.saveGraph(next),
        causalRepository.addVersion(nv),
      ]);
      await refresh();
    },
    [versions, evidence, toleranceMin, refresh],
  );

  const saveEvidenceRows = useCallback(
    async (rows: CausalEvidence[]) => {
      await causalRepository.saveEvidence(rows);
      await refresh();
    },
    [refresh],
  );

  const applyMaintenance = useCallback(async () => {
    if (!graph) return;
    const latest = [...versions].sort((a, b) => b.versionNo - a.versionNo)[0];
    if (!latest) throw new Error('缺少基线推断版本，请先装载样例');
    const changeSet = buildV2ChangeSet();
    if (graph.edges.some((e) => e.id === 'CL-FLOOD-GW')) {
      await refresh();
      return; // 幂等：v2 变更已应用
    }
    const nextGraph = applyMaintenanceChange(graph, changeSet);
    const nv = createNextVersion({
      parent: latest,
      newGraph: nextGraph,
      evidence,
      toleranceMin,
      changeSet,
      createdAt: MAINT_AT,
    });
    await Promise.all([
      causalRepository.saveGraph(nextGraph),
      causalRepository.addVersion(nv),
    ]);
    await refresh();
  }, [graph, versions, evidence, toleranceMin, refresh]);

  const freezeRationaleFor = useCallback(
    async (input: { eventRef: string; rootCauseId: string; comment: string }) => {
      const latest = [...versions].sort((a, b) => b.versionNo - a.versionNo)[0];
      if (!latest || !graph) return null;
      const scores = scoreClaims(graph, evidence, clusters, {
        window: { start: ANALYSIS_WINDOW.start, end: ANALYSIS_WINDOW.end },
        toleranceMin,
        recoveredAt: '2026-07-15T16:20:00+08:00',
      });
      const node = graph.nodes.find((n) => n.id === input.rootCauseId);
      const rootVerdict = rootCauseVerdicts(graph, scores).get(input.rootCauseId) ?? 'insufficient';
      const { rationale, freezeVersionId } = freezeRationale({
        version: latest,
        eventRef: input.eventRef,
        rootCauseId: input.rootCauseId,
        rootCauseLabel: node?.label ?? input.rootCauseId,
        verdict: rootVerdict,
        comment: input.comment,
        createdAt: MAINT_AT,
        scores,
      });
      await causalRepository.addRationale(rationale);
      await causalRepository.freezeVersion(freezeVersionId);
      await refresh();
      return rationale;
    },
    [versions, graph, evidence, clusters, toleranceMin, refresh],
  );

  const reset = useCallback(async () => {
    await causalRepository.resetCausal();
    await refresh();
  }, [refresh]);

  const value = useMemo<CausalCtx>(
    () => ({
      ready,
      graph,
      evidence,
      clusters,
      versions,
      rationales,
      toleranceMin,
      setToleranceMin,
      seed,
      saveGraph,
      saveEvidenceRows,
      applyMaintenance,
      freezeRationaleFor,
      reset,
    }),
    [ready, graph, evidence, clusters, versions, rationales, toleranceMin, seed, saveGraph, saveEvidenceRows, applyMaintenance, freezeRationaleFor, reset],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCausal(): CausalCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useCausal 必须在 CausalProvider 内使用');
  return ctx;
}
