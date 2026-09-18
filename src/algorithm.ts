import { contentId, sha256Bytes, sha256Hex } from "./canonical.js";
import type {
  DerivedMetric,
  InputManifest,
  MetricRun,
  MotorTrial,
  ParameterSet,
  SegmentWindow,
  TremorMetrics,
} from "./contracts.js";

export const ALGORITHM_VERSIONS = ["tremor-algo-1.0.0", "tremor-algo-1.1.0"] as const;
export type AlgorithmVersion = (typeof ALGORITHM_VERSIONS)[number];

export interface TrialInput {
  trial: MotorTrial;
  signalBytes: Buffer;
}

export interface RunOutput {
  run: MetricRun;
  metrics: DerivedMetric[];
}

/**
 * 依据不可变输入清单运行算法：
 * 1. 校验每个试次的规范化哈希与信号 blob 哈希，任何篡改立即失败；
 * 2. 只处理 manifest 中列出的试次（不可变输入清单）；
 * 3. run/指标均内容寻址，同输入同 ID，可安全重算，结果互不覆盖。
 */
export function runMetrics(
  algorithmVersion: AlgorithmVersion,
  params: ParameterSet,
  manifest: InputManifest,
  inputs: Map<string, TrialInput>,
  createdAt: string,
): RunOutput {
  if (params.sampleRateHz !== manifest.sampleRateHz) {
    throw new Error("parameter sample rate disagrees with manifest sample rate");
  }
  const orderedTrialIds = manifest.entries.map((e) => e.trialId).sort();

  const metrics: DerivedMetric[] = [];
  for (const trialId of orderedTrialIds) {
    const entry = manifest.entries.find((e) => e.trialId === trialId);
    if (!entry) throw new Error(`manifest entry missing: ${trialId}`);
    const input = inputs.get(trialId);
    if (!input) throw new Error(`signal input missing for trial: ${trialId}`);

    // 输入完整性：规范化试次与信号字节必须与清单一致。
    if (sha256Hex(input.trial) !== entry.normalizedTrialSha256) {
      throw new Error(`normalized trial hash mismatch for ${trialId}`);
    }
    if (sha256Bytes(input.signalBytes) !== entry.segments[0]?.blobSha256) {
      throw new Error(`signal blob hash mismatch for ${trialId}`);
    }

    metrics.push(deriveOne(algorithmVersion, params, input.trial, input.signalBytes));
  }

  const runBody = {
    algorithmVersion,
    parameterVersion: params.parameterVersion,
    inputManifestId: manifest.manifestId,
    inputTrialIds: orderedTrialIds,
  };
  const run: MetricRun = {
    runId: contentId("run", runBody),
    ...runBody,
    createdAt,
  };
  // 指标回填 runId（runId 由与指标无关的输入决定，不存在循环依赖问题）。
  for (const m of metrics) m.runId = run.runId;

  return { run, metrics };
}

function deriveOne(
  algorithmVersion: AlgorithmVersion,
  params: ParameterSet,
  trial: MotorTrial,
  bytes: Buffer,
): DerivedMetric {
  const frame = decodeTriaxial(bytes, trial.segments[0]!.sampleCount);
  const spectrum = bandSpectrum(frame, params);

  const value: TremorMetrics =
    algorithmVersion === "tremor-algo-1.0.0"
      ? scoreV1(spectrum, params)
      : scoreV2(spectrum, params);

  const coverageRatio =
    Math.round((trial.capturedDurationSeconds / trial.scheduledDurationSeconds) * 1000) / 1000;
  if (coverageRatio > 1.0001) throw new Error(`trial ${trial.trialId}: captured longer than scheduled`);
  value.coverageRatio = coverageRatio;

  const qualityFlags: string[] = [];
  if (trial.status === "interrupted") qualityFlags.push("status-interrupted");
  if (trial.status === "make-up") qualityFlags.push("status-make-up-unconfirmed");
  for (const d of trial.deviations) qualityFlags.push(`deviation:${d}`);
  if (coverageRatio < params.minCoverageRatio) qualityFlags.push("coverage-below-min");
  const syncAgeSeconds = Math.abs((trial.syncPulseAt - trial.deviceClockStart) / 1000);
  if (syncAgeSeconds > params.maxSyncAgeSeconds) qualityFlags.push("sync-pulse-stale");

  const segmentWindows: SegmentWindow[] = trial.segments.map((s) => ({
    segmentId: s.segmentId,
    blobSha256: s.blobSha256,
    windowMs: [s.startOffsetMs, s.endOffsetMs],
  }));

  const metricBody = {
    algorithmVersion,
    parameterVersion: params.parameterVersion,
    trialId: trial.trialId,
    value,
    qualityFlags: [...qualityFlags].sort(),
    segmentWindows,
  };
  return {
    metricId: contentId("metric", metricBody),
    runId: "", // 由 runMetrics 回填
    trialId: trial.trialId,
    visitId: trial.visitId,
    task: trial.task,
    side: trial.side,
    cueVersion: trial.cueVersion,
    protocolId: trial.protocolId,
    protocolVersion: trial.protocolVersion,
    medicationPhaseMinutes: trial.medicationPhaseMinutes,
    qualityFlags: [...qualityFlags].sort(),
    value,
    segmentWindows,
  };
}

interface Frame {
  axis: [Float64Array, Float64Array, Float64Array];
  n: number;
}

function decodeTriaxial(bytes: Buffer, sampleCount: number): Frame {
  const expected = sampleCount * 3 * 4;
  if (bytes.length !== expected) {
    throw new Error(`signal byte length ${bytes.length} != expected ${expected}`);
  }
  const x = new Float64Array(sampleCount);
  const y = new Float64Array(sampleCount);
  const z = new Float64Array(sampleCount);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < sampleCount; i++) {
    const o = i * 12;
    x[i] = view.getFloat32(o, true);
    y[i] = view.getFloat32(o + 4, true);
    z[i] = view.getFloat32(o + 8, true);
  }
  return { axis: [x, y, z], n: sampleCount };
}

interface Bin {
  frequencyHz: number;
  /** 每个轴的正弦幅度（g），amp = 2|X|/N。 */
  amp: [number, number, number];
}

/** 在震颤频带内做确定性 DFT 扫频（Goertzel 单遍），分辨率 = fs/N。 */
function bandSpectrum(frame: Frame, params: ParameterSet): { bins: Bin[]; sampleRateHz: number } {
  const { n } = frame;
  const fs = params.sampleRateHz;
  const [fLow, fHigh] = params.tremorBandHz;
  const kLow = Math.max(1, Math.ceil((fLow * n) / fs));
  const kHigh = Math.min(Math.floor(n / 2), Math.floor((fHigh * n) / fs));
  const bins: Bin[] = [];
  for (let k = kLow; k <= kHigh; k++) {
    const ampAxis = frame.axis.map((series) => goertzelAmplitude(series, k, n)) as [number, number, number];
    bins.push({ frequencyHz: Math.round(((k * fs) / n) * 1000) / 1000, amp: ampAxis });
  }
  return { bins, sampleRateHz: fs };
}

function goertzelAmplitude(x: Float64Array, k: number, n: number): number {
  const omega = (2 * Math.PI * k) / n;
  const coeff = 2 * Math.cos(omega);
  let sPrev = 0;
  let sPrev2 = 0;
  for (let i = 0; i < n; i++) {
    const s = x[i]! + coeff * sPrev - sPrev2;
    sPrev2 = sPrev;
    sPrev = s;
  }
  // |X|^2 = sPrev^2 + sPrev2^2 − coeff*sPrev*sPrev2
  const power = sPrev * sPrev + sPrev2 * sPrev2 - coeff * sPrev * sPrev2;
  return (2 * Math.sqrt(Math.max(0, power))) / n;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** v1.0.0：仅取主震颤轴（x 轴）频带能量。 */
function scoreV1(spectrum: { bins: Bin[] }, params: ParameterSet): TremorMetrics {
  let peak = spectrum.bins[0]!;
  for (const bin of spectrum.bins) {
    if (bin.amp[0] > peak.amp[0]) peak = bin;
  }
  let bandEnergy = 0;
  for (const bin of spectrum.bins) bandEnergy += bin.amp[0] * bin.amp[0];
  const amplitudeG = Math.sqrt(bandEnergy);
  return {
    tremorScore: round2(params.scoreScale * amplitudeG),
    peakFrequencyHz: round3(peak.frequencyHz),
    amplitudeG: round3(amplitudeG),
    coverageRatio: 0, // 由调用方按试次时长覆盖
  };
}

/** v1.1.0：三轴合成频带能量（抗轴向差异），频率峰值按三轴总功率定位。 */
function scoreV2(spectrum: { bins: Bin[] }, params: ParameterSet): TremorMetrics {
  let peak = spectrum.bins[0]!;
  let peakPower = -1;
  let bandEnergy = 0;
  for (const bin of spectrum.bins) {
    const binPower = bin.amp.reduce((acc, a) => acc + a * a, 0);
    bandEnergy += binPower;
    if (binPower > peakPower) {
      peakPower = binPower;
      peak = bin;
    }
  }
  const amplitudeG = Math.sqrt(bandEnergy);
  return {
    tremorScore: round2(params.scoreScale * amplitudeG),
    peakFrequencyHz: round3(peak.frequencyHz),
    amplitudeG: round3(amplitudeG),
    coverageRatio: 0,
  };
}
