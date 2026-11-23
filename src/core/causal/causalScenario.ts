// ============================================================
// 汛期燃气井进水事件：专家维护的因果图 + 证据语义标注样例
//
// 场景（2026-07-15 汛期前夕，低洼小区燃气井）：
//   14:00 起强降雨；14:40 雨量站/供电监测/网关心跳同时失联（共用配电箱 A）；
//   进水传感器缺报、浓度读数延迟；16:20 现场排水完成且供电恢复；
//   16:30 起浓度仍持续升高；整改工单 15:00 到期未闭环；
//   18:30 仅接收到一条外部气象复核（链路延迟未知）；次日维修结论改变边适用条件。
//
// 全部数据确定性生成，不使用随机数。
// ============================================================

import type {
  CausalEvidence,
  CausalGraph,
  DependencyCluster,
} from './types';

const DAY = '2026-07-15';
const NEXT_DAY = '2026-07-16';
export const ct = (h: number, m = 0, day = DAY) =>
  `${day}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+08:00`;

export const ANALYSIS_WINDOW = { start: ct(14, 0), end: ct(18, 0), toleranceMin: 15 };

// ---------------- 依赖簇 ----------------
export const CLUSTER_BOX_A = 'CL-BOX-A';
export const CLUSTER_SENSOR = 'CL-SENSOR';
export const CLUSTER_FIELD = 'CL-FIELD';
export const CLUSTER_DISPATCH = 'CL-DISPATCH';
export const CLUSTER_EXT = 'CL-EXT';
export const CLUSTER_MAINT = 'CL-MAINT';

export function buildClusters(): DependencyCluster[] {
  return [
    {
      id: CLUSTER_BOX_A,
      name: '配电箱 A 共链路簇',
      description:
        '雨量站 rain-station-01、网关 gateway-07、供电监测 power-monitor-09 共用同一配电箱与回传链路；14:40 同时失联，簇内多条记录只能合并计一次，不得叠加为“暴雨”的双重支持。',
      sources: ['rain-station-01', 'gateway-07', 'power-monitor-09'],
      sharedFailure: true,
    },
    {
      id: CLUSTER_SENSOR,
      name: '井场传感器直连簇',
      description: '燃气浓度/进水传感器 gas-sensor-03 与井内水位计 water-sensor-05，独立电池供电，不经配电箱 A。',
      sources: ['gas-sensor-03', 'water-sensor-05'],
      sharedFailure: false,
    },
    {
      id: CLUSTER_FIELD,
      name: '现场人工链路簇',
      description: '排水班组与巡检员的现场人工记录，纸质工单回传，不依赖无线链路。',
      sources: ['drainage-team', 'inspector-zhang'],
      sharedFailure: false,
    },
    {
      id: CLUSTER_DISPATCH,
      name: '工单系统簇',
      description: '调度整改工单系统，独立机房供电。',
      sources: ['work-order-system'],
      sharedFailure: false,
    },
    {
      id: CLUSTER_EXT,
      name: '外部气象复核簇',
      description: '外部气象局接口，跨机构数据，链路延迟不可观测，仅记录接收时间。',
      sources: ['weather-bureau-api'],
      sharedFailure: false,
    },
    {
      id: CLUSTER_MAINT,
      name: '维修班组结论簇',
      description: '次日维修班组现场拆机后的后补结论，用于改写边适用条件、触发新推断版本。',
      sources: ['maintenance-team'],
      sharedFailure: false,
    },
  ];
}

// ---------------- 专家因果图 ----------------
export function buildCausalGraph(): CausalGraph {
  return {
    id: 'CG-FLOOD-1',
    name: '汛期燃气井进水因果假设图（专家维护）',
    description:
      '候选根因、机制、可观测征兆、前置条件与下游影响组成的有向图；每条边是一条可独立检验的主张，如“暴雨导致进水”与“进水导致供电中断”分开检验。',
    nodes: [
      // 候选根因
      { id: 'RC-STORM', kind: 'root_cause', label: '暴雨', description: '短时强降雨超过低洼小区排水能力' },
      { id: 'RC-LEAK', kind: 'root_cause', label: '真实燃气泄漏', description: '管道或密封件失效导致的真实泄漏，与积水无关' },
      { id: 'RC-SENSOR-FAULT', kind: 'root_cause', label: '传感器进水失效', description: '传感器本体进水导致电路失效' },
      { id: 'H-WATER-ONLY', kind: 'root_cause', label: '仅积水导致异常（排除泄漏）', description: '候选解释假设：全部异常均可由积水可逆解释，不存在泄漏' },
      // 机制
      {
        id: 'M-FLOOD', kind: 'mechanism', label: '井室积水', description: '雨水进入燃气井室',
        blocksObservables: [],
      },
      {
        id: 'M-POWER', kind: 'mechanism', label: '供电中断',
        description: '配电箱跳闸/短路停电；共箱设备（雨量站、网关、供电监测）全部失联',
        blocksObservables: ['heavy_rain', 'power_loss', 'heartbeat_loss'],
      },
      {
        id: 'M-GW', kind: 'mechanism', label: '网关回传失败',
        description: '网关无法回传，经网关上报的传感器观测全部不可得，恢复上报同样被屏蔽',
        blocksObservables: ['sensor_missing', 'concentration_delay', 'concentration_rise', 'sensor_recovery'],
      },
      // 前置条件
      { id: 'P-BOX', kind: 'precondition', label: '雨量站与网关共用配电箱', description: 'CL-POWER-GW 的适用前提；维修结论可能改写', holds: true },
      { id: 'P-DRAINABLE', kind: 'precondition', label: '积水可经排水恢复', description: '排水后供电与传感器应恢复正常', holds: true },
      // 可观测征兆
      { id: 'S-RAIN', kind: 'symptom', label: '强降雨记录', description: '小时雨量超过内涝阈值', observableKey: 'heavy_rain' },
      { id: 'S-WATER', kind: 'symptom', label: '井内水位上升', description: '水位计记录井室进水', observableKey: 'water_in_well' },
      { id: 'S-POWER-LOSS', kind: 'symptom', label: '供电监测离线', description: '供电监测无上报', observableKey: 'power_loss' },
      { id: 'S-HB-LOSS', kind: 'symptom', label: '网关心跳中断', description: '心跳超过间隔阈值', observableKey: 'heartbeat_loss' },
      { id: 'S-MISSING', kind: 'symptom', label: '进水传感器缺报', description: '应到未到的进水传感器报文', observableKey: 'sensor_missing' },
      { id: 'S-DELAY', kind: 'symptom', label: '浓度读数延迟', description: '采样与接收时间差超限', observableKey: 'concentration_delay' },
      { id: 'S-CONC', kind: 'symptom', label: '浓度持续升高', description: '排水恢复后浓度不降反升', observableKey: 'concentration_rise' },
      // 下游影响
      { id: 'I-OVERDUE', kind: 'impact', label: '整改工单逾期', description: '缺报未及时处置传导为工单逾期', observableKey: 'work_order_overdue' },
      { id: 'I-SAFETY', kind: 'impact', label: '现场安全判断（恢复供气）', description: '是否可恢复供气的安全结论，受上游不确定性传导', observableKey: 'safety_resume' },
    ],
    edges: [
      {
        id: 'CL-STORM-FLOOD', from: 'RC-STORM', to: 'M-FLOOD',
        label: '暴雨导致井室进水', preconditionIds: [],
        expectedCounterObservables: ['water_in_well'], enabled: true,
      },
      {
        id: 'CL-FLOOD-POWER', from: 'M-FLOOD', to: 'M-POWER',
        label: '进水导致供电中断', preconditionIds: [],
        expectedCounterObservables: ['power_loss'], enabled: true,
      },
      {
        id: 'CL-POWER-GW', from: 'M-POWER', to: 'M-GW',
        label: '供电中断导致网关回传失败', preconditionIds: ['P-BOX'],
        expectedCounterObservables: ['heartbeat_loss'], enabled: true,
      },
      {
        id: 'CL-GW-MISSING', from: 'M-GW', to: 'S-MISSING',
        label: '网关失败导致进水传感器缺报', preconditionIds: [],
        // 若仅网关失败：通道恢复后传感器应恢复上报（sensor_recovery），
        // 恢复后仍无上报则反驳“纯网关解释”、指向传感器本体失效。
        expectedCounterObservables: ['sensor_missing', 'sensor_recovery'], enabled: true,
      },
      {
        id: 'CL-GW-DELAY', from: 'M-GW', to: 'S-DELAY',
        label: '网关回传失败导致浓度读数延迟', preconditionIds: [],
        expectedCounterObservables: ['concentration_delay'], enabled: true,
      },
      {
        id: 'CL-FLOOD-SENSOR-FAIL', from: 'M-FLOOD', to: 'S-MISSING',
        label: '进水致传感器本体失效缺报', preconditionIds: [],
        expectedCounterObservables: ['sensor_missing'], enabled: true,
      },
      {
        id: 'CL-SENSORF-MISSING', from: 'RC-SENSOR-FAULT', to: 'S-MISSING',
        label: '传感器进水失效导致缺报（竞争根因）', preconditionIds: [],
        expectedCounterObservables: ['sensor_missing'], enabled: true,
      },
      {
        id: 'CL-WATER-ONLY', from: 'M-FLOOD', to: 'H-WATER-ONLY',
        label: '积水足以解释全部异常（仅积水假设）', preconditionIds: ['P-DRAINABLE'],
        // 若仅积水假设成立：排水恢复后浓度不应升高、传感器应恢复上报；
        // 两者在通道恢复后仍缺失/反向出现，即构成缺证反证与直接反证。
        expectedCounterObservables: ['concentration_rise', 'sensor_recovery'], enabled: true,
      },
      {
        id: 'CL-HWO-SAFETY', from: 'H-WATER-ONLY', to: 'I-SAFETY',
        label: '仅积水假设成立则可恢复供气', preconditionIds: [],
        expectedCounterObservables: [], enabled: true,
      },
      {
        id: 'CL-LEAK-CONC', from: 'RC-LEAK', to: 'S-CONC',
        label: '真实泄漏导致浓度持续升高', preconditionIds: [],
        expectedCounterObservables: ['concentration_rise'], enabled: true,
      },
      {
        id: 'CL-LEAK-SAFETY', from: 'RC-LEAK', to: 'I-SAFETY',
        label: '泄漏未排除前禁止恢复供气', preconditionIds: [],
        expectedCounterObservables: [], enabled: true,
      },
      {
        id: 'CL-MISSING-OVERDUE', from: 'S-MISSING', to: 'I-OVERDUE',
        label: '缺报处置延迟导致工单逾期', preconditionIds: [],
        expectedCounterObservables: ['work_order_overdue'], enabled: true,
      },
    ],
  };
}

// ---------------- 证据语义标注册 ----------------
export function buildCausalEvidence(): CausalEvidence[] {
  return [
    {
      id: 'CE-01', kind: 'rainfall', label: '雨量站强降雨记录', source: 'rain-station-01',
      reliability: 'medium', clusterId: CLUSTER_BOX_A,
      interval: { start: ct(14, 0), end: ct(15, 30), receiveOnly: false, delayUnknown: false, note: '雨量站分钟雨量累计，14:00–15:30 超内涝阈值' },
      observableKey: 'heavy_rain', polarity: 'support', claimId: 'CL-STORM-FLOOD',
      detail: '直接观测到强降雨；但雨量站与网关共用配电箱 A，链路同源。', missing: false,
    },
    {
      id: 'CE-02', kind: 'power', label: '配电箱供电监测离线', source: 'power-monitor-09',
      reliability: 'medium', clusterId: CLUSTER_BOX_A,
      interval: { start: ct(14, 40), end: ct(16, 20), receiveOnly: false, delayUnknown: false, note: '14:40 起无供电监测上报，16:20 恢复' },
      observableKey: 'power_loss', polarity: 'support', claimId: 'CL-FLOOD-POWER',
      detail: '供电中断的直接监测；与雨量站、网关同属配电箱 A 共链路簇。', missing: false,
    },
    {
      id: 'CE-03', kind: 'gateway_heartbeat', label: '网关心跳中断', source: 'gateway-07',
      reliability: 'medium', clusterId: CLUSTER_BOX_A,
      interval: { start: ct(14, 41), end: ct(16, 20), receiveOnly: false, delayUnknown: false, note: '心跳 14:41 起中断，16:20 恢复' },
      observableKey: 'heartbeat_loss', polarity: 'support', claimId: 'CL-POWER-GW',
      detail: '心跳中断只支持“供电→网关失败”这一段主张，不能作为暴雨的独立佐证（同簇）。', missing: false,
    },
    {
      id: 'CE-04', kind: 'power', label: '供电异常作为暴雨间接信号', source: 'power-monitor-09',
      reliability: 'medium', clusterId: CLUSTER_BOX_A,
      interval: { start: ct(14, 40), end: ct(16, 20), receiveOnly: false, delayUnknown: false, note: '值班员对同一供电事件的间接解读记录' },
      observableKey: 'power_loss', polarity: 'support', claimId: 'CL-STORM-FLOOD',
      detail: '与 CE-01 同属配电箱 A 共链路簇；即使两条都指向暴雨，簇内合并只能计一次。', missing: false,
    },
    {
      id: 'CE-05', kind: 'water_level', label: '井内水位上升记录', source: 'water-sensor-05',
      reliability: 'high', clusterId: CLUSTER_SENSOR,
      interval: { start: ct(14, 20), end: ct(15, 10), receiveOnly: false, delayUnknown: false, note: '独立电池供电的水位计实测进水过程' },
      observableKey: 'water_in_well', polarity: 'support', claimId: 'CL-STORM-FLOOD',
      detail: '来自与配电箱 A 独立的传感器簇，是暴雨→进水主张的独立佐证。', missing: false,
    },
    {
      id: 'CE-06', kind: 'sensor_status', label: '进水传感器缺报', source: 'gas-sensor-03',
      reliability: 'high', clusterId: CLUSTER_SENSOR,
      interval: { start: ct(14, 45), end: ct(18, 0), receiveOnly: false, delayUnknown: false, note: '14:45 起应到未到；网关失败与传感器失效均可解释' },
      observableKey: 'sensor_missing', polarity: 'neutral',
      detail: '征兆本身不预先站队：缺报可能来自网关回传失败，也可能来自传感器进水失效。', missing: false,
    },
    {
      id: 'CE-07', kind: 'concentration', label: '浓度读数延迟（采样 15:00 / 接收 15:35）', source: 'gas-sensor-03',
      reliability: 'high', clusterId: CLUSTER_SENSOR,
      interval: { start: ct(15, 0), end: ct(15, 35), receiveOnly: false, delayUnknown: false, note: '采样时间已知，端到端延迟 35 分钟' },
      observableKey: 'concentration_delay', polarity: 'support', claimId: 'CL-GW-DELAY',
      detail: '延迟发生在网关心跳中断窗口内。', missing: false,
    },
    {
      id: 'CE-08', kind: 'concentration', label: '排水后浓度持续升高（反证仅积水假设）', source: 'gas-sensor-03',
      reliability: 'high', clusterId: CLUSTER_SENSOR,
      interval: { start: ct(16, 30), end: ct(17, 30), receiveOnly: false, delayUnknown: false, note: '排水完成、供电恢复后，浓度由 18%LEL 升至 41%LEL' },
      observableKey: 'concentration_rise', polarity: 'refute', claimId: 'CL-WATER-ONLY',
      detail: '通道已恢复正常，此为“仅积水”假设下本不应出现的观测，构成真实缺证反证，而非通道屏蔽。', missing: false,
    },
    {
      id: 'CE-09', kind: 'concentration', label: '浓度趋势支持泄漏假设', source: 'gas-sensor-03',
      reliability: 'high', clusterId: CLUSTER_SENSOR,
      interval: { start: ct(16, 30), end: ct(17, 30), receiveOnly: false, delayUnknown: false, note: '同一浓度趋势对竞争假设的支持解读' },
      observableKey: 'concentration_rise', polarity: 'support', claimId: 'CL-LEAK-CONC',
      detail: '与 CE-08 同簇同观测、极性随主张不同；簇内按主张分别合并。', missing: false,
    },
    {
      id: 'CE-10', kind: 'drainage', label: '现场排水完成记录', source: 'drainage-team',
      reliability: 'high', clusterId: CLUSTER_FIELD,
      interval: { start: ct(16, 0), end: ct(16, 20), receiveOnly: false, delayUnknown: false, note: '人工排水作业，16:20 确认井室无积水' },
      observableKey: 'drainage_done', polarity: 'neutral',
      detail: '事实记录：标志积水通道恢复，此后缺失观测不能再归因于通道屏蔽。', missing: false,
    },
    {
      id: 'CE-11', kind: 'power', label: '供电恢复确认', source: 'inspector-zhang',
      reliability: 'high', clusterId: CLUSTER_FIELD,
      interval: { start: ct(16, 20), end: ct(16, 20), receiveOnly: false, delayUnknown: false, note: '巡检员现场合闸确认' },
      observableKey: 'power_restored', polarity: 'support', claimId: 'CL-FLOOD-POWER',
      detail: '恢复过程印证“进水→供电中断”的可逆因果。', missing: false,
    },
    {
      id: 'CE-12', kind: 'work_order', label: '整改工单逾期', source: 'work-order-system',
      reliability: 'high', clusterId: CLUSTER_DISPATCH,
      interval: { start: ct(15, 0), end: ct(17, 0), receiveOnly: false, delayUnknown: false, note: '工单截止 15:00，17:00 仍未闭环' },
      observableKey: 'work_order_overdue', polarity: 'support', claimId: 'CL-MISSING-OVERDUE',
      detail: '缺报后的处置延迟传导为工单逾期。', missing: false,
    },
    {
      id: 'CE-13', kind: 'rainfall', label: '外部气象复核（仅接收时间戳）', source: 'weather-bureau-api',
      reliability: 'low', clusterId: CLUSTER_EXT,
      interval: {
        start: ct(16, 30), end: ct(18, 30), receiveOnly: true, delayUnknown: true,
        note: '只记录 18:30 接收，链路延迟未知；按延迟上界 120 分钟保留区间 16:30–18:30，真实发生时间不可定位',
      },
      observableKey: 'heavy_rain', polarity: 'refute', claimId: 'CL-STORM-FLOOD',
      detail: '称目标小区降雨未达内涝阈值；是暴雨主张唯一反驳证据，但时间不可定位，稳健性台不得据此点证据排除假设。', missing: false,
    },
    {
      id: 'CE-14', kind: 'maintenance', label: '后补维修结论：网关独立备用电池', source: 'maintenance-team',
      reliability: 'high', clusterId: CLUSTER_MAINT,
      interval: { start: ct(9, 0, NEXT_DAY), end: ct(9, 0, NEXT_DAY), receiveOnly: false, delayUnknown: false, note: '拆机确认：网关有独立备用电池，配电箱跳闸不影响回传；通信模块为进水烧毁' },
      observableKey: 'maintenance_finding', polarity: 'neutral',
      detail: '改写 P-BOX 适用条件：CL-POWER-GW 停用，新增“进水→网关失败”主张，触发推断版本 v2。', missing: false,
    },
  ];
}

// ---------------- 维修结论驱动的图变更（v2） ----------------
export interface MaintenanceChangeSet {
  triggeredByEvidenceId: string | null;
  reason: string;
  changes: string[];
  nodeUpdates: { id: string; holds: boolean }[];
  edgeDisableIds: string[];
  edgeAdds: CausalGraph['edges'];
}

export function buildV2ChangeSet(): MaintenanceChangeSet {
  return {
    triggeredByEvidenceId: 'CE-14',
    reason: '维修班组拆机确认网关具备独立备用电池，供电中断不必然导致网关失败，原边适用前提不成立。',
    changes: [
      '前置条件 P-BOX（雨量站与网关共用配电箱）改写为不成立',
      '主张 CL-POWER-GW（供电中断导致网关回传失败）因前提失败停用',
      '新增主张 CL-FLOOD-GW（进水烧毁通信模块导致网关失败）',
    ],
    nodeUpdates: [{ id: 'P-BOX', holds: false }],
    edgeDisableIds: ['CL-POWER-GW'],
    edgeAdds: [
      {
        id: 'CL-FLOOD-GW', from: 'M-FLOOD', to: 'M-GW',
        label: '进水烧毁通信模块导致网关失败', preconditionIds: [],
        expectedCounterObservables: ['heartbeat_loss'], enabled: true,
      },
    ],
  };
}
