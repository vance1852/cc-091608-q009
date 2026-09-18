/**
 * 运动量化评估领域契约。
 *
 * 设计约束：
 * - 原始试次（RawTrialRecord，见 ingest.ts）与规范化后的 {@link MotorTrial} 分开保存，
 *   任何派生结果都必须能回溯到不可变输入清单 {@link InputManifest}。
 * - 指标按「算法版本 + 参数版本 + 输入清单」内容寻址，同一输入可安全重算；
 *   新版本的结果与旧结果并列保存，互不覆盖。
 * - 临床摘要一旦签署，其载荷字节即冻结，后续重算不得改变签署内容。
 * - 跨访视比较只允许在（任务, 佩戴侧, 提示版本, 服药相位）对齐的试次间进行，
 *   禁止直接拼接左右腕或不同方案的指标。
 */

export type MotorTask = "rest" | "posture" | "pronation-supination" | "walk";
export type WristSide = "left" | "right";
export type TrialStatus = "completed" | "interrupted" | "make-up";
export type SignalChannel = "accelerometer";
export type ReviewDecision = "include" | "exclude" | "confirm-make-up";
export type SelectionBasis = "completed" | "confirmed-make-up";

// ── 评估方案 ───────────────────────────────────────────────────────────────

export interface ProtocolTaskSpec {
  kind: MotorTask;
  /** 方案规定的采集时长（秒）。 */
  durationSeconds: number;
  /** 动作提示（节拍器）版本；不同版本的试次不得直接比较。 */
  cueVersion: string;
}

export interface ProtocolVersion {
  protocolId: string;
  version: number;
  tasks: ProtocolTaskSpec[];
  publishedAt: string;
}

// ── 信号证据与试次 ─────────────────────────────────────────────────────────

export interface SignalSegment {
  segmentId: string;
  channel: SignalChannel;
  /** 相对试次设备时钟起点的毫秒区间（信号窗口可追溯）。 */
  startOffsetMs: number;
  endOffsetMs: number;
  sampleCount: number;
  sampleRateHz: number;
  /** 原始信号二进制的不可变引用与摘要（演示环境为合成信号）。 */
  blobUri: string;
  blobSha256: string;
}

export interface MotorTrial {
  trialId: string;
  visitId: string;
  protocolId: string;
  protocolVersion: number;
  task: MotorTask;
  side: WristSide;
  /** 实际使用的提示版本，默认取自方案任务规格，可被采集端覆盖并留痕。 */
  cueVersion: string;
  medicationTakenAt: string;

  // 设备侧时钟与同步脉冲：clinicalStartAt 只能通过脉冲锚点换算得到。
  deviceClockStart: number;
  syncPulseAt: number;
  syncPulseClinicalAt: string;
  clinicalStartAt: string;
  /** 试次开始相对服药时刻的分钟数（服药相位）。 */
  medicationPhaseMinutes: number;

  status: TrialStatus;
  deviations: string[];
  /** 方案要求时长 vs 实际采到的时长（中断试次小于规定值）。 */
  scheduledDurationSeconds: number;
  capturedDurationSeconds: number;

  segments: SignalSegment[];
  recordedAt: string;
}

// ── 不可变输入清单 ─────────────────────────────────────────────────────────

export interface ManifestEntry {
  trialId: string;
  rawRecordSha256: string;
  normalizedTrialSha256: string;
  segments: SignalSegment[];
}

export interface InputManifest {
  manifestId: string;
  sourceUri: string;
  sourceSha256: string;
  /** 规范化程序本身也是处理链的一环，必须留版本。 */
  normalizerVersion: string;
  sampleRateHz: number;
  entries: ManifestEntry[];
  createdAt: string;
}

// ── 算法参数与派生指标 ─────────────────────────────────────────────────────

export interface ParameterSet {
  parameterVersion: string;
  /** 两次试次服药相位差超过该值即判为不可比（分钟）。 */
  phaseToleranceMinutes: number;
  /** 震颤分析频带（Hz）。 */
  tremorBandHz: [number, number];
  /** 分数缩放系数（演示用量纲）。 */
  scoreScale: number;
  /** 有效信号覆盖比例下限，低于则标记质量问题。 */
  minCoverageRatio: number;
  sampleRateHz: number;
  /** 同步脉冲距试次开始超过该秒数时给出质量标记。 */
  maxSyncAgeSeconds: number;
}

export interface TremorMetrics {
  tremorScore: number;
  peakFrequencyHz: number;
  amplitudeG: number;
  /** 实际有效样本占方案规定时长的比例（中断试次 < 1）。 */
  coverageRatio: number;
}

export interface SegmentWindow {
  segmentId: string;
  blobSha256: string;
  windowMs: [number, number];
}

export interface DerivedMetric {
  metricId: string;
  runId: string;
  trialId: string;
  visitId: string;
  task: MotorTask;
  side: WristSide;
  cueVersion: string;
  protocolId: string;
  protocolVersion: number;
  medicationPhaseMinutes: number;
  qualityFlags: string[];
  value: TremorMetrics;
  segmentWindows: SegmentWindow[];
}

export interface MetricRun {
  runId: string;
  algorithmVersion: string;
  parameterVersion: string;
  inputManifestId: string;
  inputTrialIds: string[];
  createdAt: string;
}

// ── 治疗师复核与临床摘要 ───────────────────────────────────────────────────

export interface TrialReview {
  reviewId: string;
  trialId: string;
  decision: ReviewDecision;
  reason: string;
  reviewerId: string;
  decidedAt: string;
}

export interface SummarySelection {
  task: MotorTask;
  side: WristSide;
  chosenTrialId: string;
  metricId: string;
  runId: string;
  basis: SelectionBasis;
}

export interface SummaryExclusion {
  trialId: string;
  task: MotorTask;
  side: WristSide;
  reason: string;
}

export interface ClinicalSummary {
  summaryId: string;
  patientId: string;
  visitId: string;
  protocolId: string;
  protocolVersion: number;
  algorithmVersion: string;
  parameterVersion: string;
  inputManifestId: string;
  selections: SummarySelection[];
  exclusions: SummaryExclusion[];
  reviewIds: string[];
  authorId: string;
  createdAt: string;
  note?: string;
}

export interface SignedClinicalSummary {
  summaryId: string;
  signerId: string;
  publicKeyId: string;
  signedAt: string;
  canonicalSha256: string;
  /** 对 canonicalJson 字节的 Ed25519 签名（hex）。 */
  signature: string;
  /** 被签署的精确字节；重算指标只产生新 run，不改写这里。 */
  payloadCanonicalJson: string;
}

// ── 跨访视比较 ─────────────────────────────────────────────────────────────

export type IncomparableReasonCode =
  | "no-valid-trial-baseline"
  | "no-valid-trial-followup"
  | "side-mismatch"
  | "cue-version-mismatch"
  | "protocol-spec-mismatch"
  | "medication-phase-shift"
  | "processing-version-mismatch";

export interface IncomparableReason {
  code: IncomparableReasonCode;
  message: string;
  details?: Record<string, string | number | boolean>;
}

export interface ComparedMetricRef {
  visitId: string;
  trialId: string;
  metricId: string;
  runId: string;
  basis: SelectionBasis;
  task: MotorTask;
  side: WristSide;
  tremorScore: number;
  medicationPhaseMinutes: number;
  cueVersion: string;
  protocolVersion: number;
}

export interface TrialComparison {
  task: MotorTask;
  side: WristSide;
  comparable: boolean;
  baseline: ComparedMetricRef | null;
  followup: ComparedMetricRef | null;
  /** 即使不可比也展示原始分数差，但必须同时给出原因，不得作为疗效证据。 */
  rawDeltaScore: number | null;
  deltaScore: number | null;
  reasons: IncomparableReason[];
  advisories: string[];
}

export interface VisitComparisonReport {
  reportId: string;
  patientId: string;
  baselineVisitId: string;
  followupVisitId: string;
  algorithmVersion: string;
  parameterVersion: string;
  phaseToleranceMinutes: number;
  generatedFromRunIds: string[];
  pairs: TrialComparison[];
  generatedAt: string;
}
