export type MotorTask = "rest" | "posture" | "pronation-supination" | "walk";
export type WristSide = "left" | "right";

export interface ProtocolVersion {
  protocolId: string;
  version: number;
  tasks: Array<{ kind: MotorTask; durationSeconds: number; cueVersion: string }>;
  publishedAt: string;
}

export type TrialStatus = "completed" | "interrupted" | "make-up";

export interface MotorTrial {
  trialId: string;
  visitId: string;
  task: MotorTask;
  side: WristSide;
  medicationTakenAt: string;
  deviceClockStart: number;
  syncPulseAt: number;
  deviations: string[];
  deviceId: string;
  status: TrialStatus;
  makesUpTrialId?: string;
}

export interface MetricRun {
  runId: string;
  algorithmVersion: string;
  parameterVersion: string;
  inputTrialIds: string[];
  createdAt: string;
}

/** 采集端同步脉冲：把某台设备的本地时钟锚定到墙钟时刻。 */
export interface SyncPulse {
  deviceId: string;
  deviceClockAt: number;
  wallClockAt: string;
}

/** 原始信号区间：可复算证据的最小单位，samples 为逐窗震颤带功率。 */
export interface SignalSegment {
  segmentId: string;
  trialId: string;
  deviceClockStart: number;
  deviceClockEnd: number;
  samples: number[];
  deviations: string[];
}

export type MetricName = "tremor-score";

/** 一次算法运行对单个试次产出的派生指标。 */
export interface MetricOutput {
  runId: string;
  trialId: string;
  task: MotorTask;
  side: WristSide;
  protocolVersion: number;
  metric: MetricName;
  value: number;
  unit: string;
  segmentIds: string[];
  medicationPhaseMinutes: number;
}

/** 不可变输入清单中的一项：类型 + 标识 + 内容哈希。 */
export interface InputManifestItem {
  kind: "trial" | "segment" | "protocol" | "curation";
  id: string;
  contentHash: string;
}

/** 算法运行的不可变输入清单；manifestHash 覆盖算法与参数版本。 */
export interface InputManifest {
  manifestHash: string;
  algorithmVersion: string;
  parameterVersion: string;
  items: InputManifestItem[];
}

export type CurationDecisionKind =
  | "exclude-segment"
  | "exclude-trial"
  | "confirm-make-up";

export interface CurationDecision {
  decisionId: string;
  kind: CurationDecisionKind;
  targetId: string;
  reason: string;
  decidedBy: string;
  decidedAt: string;
}

/** 一组治疗师裁量决定，版本化且只增不改。 */
export interface CurationSet {
  curationId: string;
  visitId: string;
  version: number;
  decisions: CurationDecision[];
  supersedes: string | null;
  createdAt: string;
}

/** 临床摘要中的一行：某任务 × 某侧腕的已签署数值及其追溯锚点。 */
export interface SummaryEntry {
  task: MotorTask;
  side: WristSide;
  protocolVersion: number;
  metric: MetricName;
  value: number;
  unit: string;
  runId: string;
  trialId: string;
  segmentIds: string[];
  medicationPhaseMinutes: number;
  algorithmVersion: string;
  parameterVersion: string;
}

export type SummaryStatus = "draft" | "signed";

/**
 * 临床摘要。签署后内容冻结：contentHash 只覆盖临床内容
 * （访视、裁量、运行、条目），重算产生新运行时不随之变化。
 */
export interface ClinicalSummary {
  summaryId: string;
  visitId: string;
  protocolVersion: number;
  curationId: string | null;
  runId: string;
  entries: SummaryEntry[];
  status: SummaryStatus;
  contentHash: string;
  signedBy: string | null;
  signedAt: string | null;
  supersedes: string | null;
  createdAt: string;
}

export type ComparisonReasonCode =
  | "task-not-in-protocol"
  | "no-usable-trial"
  | "protocol-spec-mismatch"
  | "medication-phase-mismatch";

export interface ComparisonIssue {
  code: ComparisonReasonCode;
  detail: string;
}

/** 比较结果按 任务 × 侧 逐行给出，绝不跨侧或跨方案合并。 */
export interface ComparisonRow {
  task: MotorTask;
  side: WristSide;
  baseline: SummaryEntry | null;
  followUp: SummaryEntry | null;
  delta: number | null;
  comparable: boolean;
  issues: ComparisonIssue[];
}

export interface VisitComparison {
  baselineVisitId: string;
  followUpVisitId: string;
  medicationPhaseToleranceMinutes: number;
  generatedAt: string;
  rows: ComparisonRow[];
}
