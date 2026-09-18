import { readFileSync } from "node:fs";
import { contentId, seededRandom, sha256Bytes, sha256Hex } from "./canonical.js";
import type {
  InputManifest,
  ManifestEntry,
  MotorTask,
  MotorTrial,
  ProtocolVersion,
  SignalSegment,
  TrialStatus,
  WristSide,
} from "./contracts.js";
import { SAMPLE_RATE_HZ } from "./parameters.js";

export const NORMALIZER_VERSION = "normalizer-1.0.0";

// ── 采集端导出的原始结构（未经任何换算的证据） ─────────────────────────────

export interface RawSignalSpec {
  tremorHz: number;
  amplitudeG: number;
  noiseG: number;
}

export interface RawTrialRecord {
  trialId: string;
  task: MotorTask;
  side: WristSide;
  deviceClockStart: number;
  /** 腕部传感器不同步：左右腕脉冲读数不一致（如 1000 vs 1160），各自独立锚定。 */
  syncPulseAt: number;
  syncPulseClinicalAt: string;
  status: TrialStatus;
  deviations: string[];
  capturedSeconds: number;
  signal: RawSignalSpec;
}

export interface RawVisit {
  visitId: string;
  protocolVersion: number;
  medicationTakenAt: string;
  trials: RawTrialRecord[];
}

export interface RawFixture {
  patientId: string;
  capturedBy: string;
  exportedAt: string;
  publishedProtocols: Array<Omit<ProtocolVersion, "tasks"> & {
    tasks: Array<ProtocolVersion["tasks"][number] & { kindLabel: string }>;
  }>;
  visits: RawVisit[];
}

export function loadFixture(path: string): RawFixture {
  return JSON.parse(readFileSync(path, "utf8")) as RawFixture;
}

// ── 规范化：设备时钟 → 临床时钟 ────────────────────────────────────────────

/**
 * 同步脉冲是唯一可信的跨时钟锚点：
 *   clinicalStart = syncPulseClinical − (syncPulseDevice − deviceClockStart)
 * 绝不能直接信任设备时钟起点（左右腕时钟不同步）。
 */
export function deriveClinicalStartAt(raw: RawTrialRecord): string {
  const pulseClinicalMs = Date.parse(raw.syncPulseClinicalAt);
  if (Number.isNaN(pulseClinicalMs)) {
    throw new Error(`trial ${raw.trialId}: invalid syncPulseClinicalAt`);
  }
  const pulseOffsetMs = raw.syncPulseAt - raw.deviceClockStart;
  return new Date(pulseClinicalMs - pulseOffsetMs).toISOString();
}

export function deriveMedicationPhaseMinutes(clinicalStartAt: string, medicationTakenAt: string): number {
  const start = Date.parse(clinicalStartAt);
  const taken = Date.parse(medicationTakenAt);
  if (Number.isNaN(start) || Number.isNaN(taken)) {
    throw new Error("invalid clock input for medication phase");
  }
  return Math.round(((start - taken) / 60000) * 100) / 100;
}

// ── 合成信号段（确定性：同一试次每次生成相同字节与摘要） ────────────────────

/**
 * 演示环境下按试次特征合成加速度信号。真实系统中这里替换为对象存储里的
 * 原始二进制；blobSha256 与区间是后续追溯「分数 → 信号窗口」的凭据。
 */
export function synthesizeSegment(raw: RawTrialRecord): { segment: SignalSegment; bytes: Buffer } {
  const sampleCount = Math.round(raw.capturedSeconds * SAMPLE_RATE_HZ);
  const seed = hashSeed(raw.trialId);
  const rand = seededRandom(seed);
  const bytes = Buffer.alloc(sampleCount * 3 * Float32Array.BYTES_PER_ELEMENT);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dt = 1 / SAMPLE_RATE_HZ;
  for (let i = 0; i < sampleCount; i++) {
    const t = i * dt;
    const tremor = raw.signal.amplitudeG * Math.sin(2 * Math.PI * raw.signal.tremorHz * t);
    // 三个轴：主震颤轴 + 串扰 + 确定性噪声。
    const x = tremor + (rand() - 0.5) * 2 * raw.signal.noiseG;
    const y = 0.35 * tremor + (rand() - 0.5) * 2 * raw.signal.noiseG;
    const z = 0.15 * tremor + (rand() - 0.5) * 2 * raw.signal.noiseG;
    const o = i * 3 * 4;
    view.setFloat32(o, x, true);
    view.setFloat32(o + 4, y, true);
    view.setFloat32(o + 8, z, true);
  }
  const segment: SignalSegment = {
    segmentId: `seg-${raw.trialId}`,
    channel: "accelerometer",
    startOffsetMs: 0,
    endOffsetMs: raw.capturedSeconds * 1000,
    sampleCount,
    sampleRateHz: SAMPLE_RATE_HZ,
    blobUri: `signal://collector/${raw.trialId}.acc.f32le`,
    blobSha256: sha256Bytes(bytes),
  };
  return { segment, bytes };
}

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ── 原始证据 → 规范化试次 + 不可变输入清单 ─────────────────────────────────

export interface IngestResult {
  fixture: RawFixture;
  protocols: ProtocolVersion[];
  trials: MotorTrial[];
  signalByTrial: Map<string, Buffer>;
  manifest: InputManifest;
  rawByTrial: Map<string, RawTrialRecord>;
}

export function ingest(fixturePath: string, sourceSha256?: string): IngestResult {
  const sourceBytes = readFileSync(fixturePath);
  const fixture = JSON.parse(sourceBytes.toString("utf8")) as RawFixture;

  const protocols: ProtocolVersion[] = fixture.publishedProtocols.map((p) => ({
    protocolId: p.protocolId,
    version: p.version,
    publishedAt: p.publishedAt,
    tasks: p.tasks.map(({ kindLabel: _kindLabel, ...task }) => task),
  }));

  const protocolOf = new Map<string, ProtocolVersion>();
  for (const p of protocols) protocolOf.set(protocolKey(p.protocolId, p.version), p);

  const trials: MotorTrial[] = [];
  const signalByTrial = new Map<string, Buffer>();
  const rawByTrial = new Map<string, RawTrialRecord>();
  const entries: ManifestEntry[] = [];

  for (const visit of fixture.visits) {
    const protocol = protocolOf.get(protocolKey("parkinson-motor-battery", visit.protocolVersion));
    if (!protocol) throw new Error(`visit ${visit.visitId}: unpublished protocol version ${visit.protocolVersion}`);

    for (const raw of visit.trials) {
      const spec = protocol.tasks.find((t) => t.kind === raw.task);
      if (!spec) throw new Error(`trial ${raw.trialId}: task ${raw.task} missing in protocol v${protocol.version}`);

      const { segment, bytes } = synthesizeSegment(raw);
      const clinicalStartAt = deriveClinicalStartAt(raw);
      const trial: MotorTrial = {
        trialId: raw.trialId,
        visitId: visit.visitId,
        protocolId: protocol.protocolId,
        protocolVersion: protocol.version,
        task: raw.task,
        side: raw.side,
        cueVersion: spec.cueVersion,
        medicationTakenAt: visit.medicationTakenAt,
        deviceClockStart: raw.deviceClockStart,
        syncPulseAt: raw.syncPulseAt,
        syncPulseClinicalAt: raw.syncPulseClinicalAt,
        clinicalStartAt,
        medicationPhaseMinutes: deriveMedicationPhaseMinutes(clinicalStartAt, visit.medicationTakenAt),
        status: raw.status,
        deviations: [...raw.deviations],
        scheduledDurationSeconds: spec.durationSeconds,
        capturedDurationSeconds: raw.capturedSeconds,
        segments: [segment],
        recordedAt: new Date(Date.parse(raw.syncPulseClinicalAt)).toISOString(),
      };

      trials.push(trial);
      signalByTrial.set(raw.trialId, bytes);
      rawByTrial.set(raw.trialId, raw);
      entries.push({
        trialId: raw.trialId,
        rawRecordSha256: sha256Hex(raw),
        normalizedTrialSha256: sha256Hex(trial),
        segments: [segment],
      });
    }
  }

  const manifestBody = {
    normalizerVersion: NORMALIZER_VERSION,
    sampleRateHz: SAMPLE_RATE_HZ,
    sourceSha256: sourceSha256 ?? sha256Bytes(sourceBytes),
    entries,
  };
  const manifest: InputManifest = {
    manifestId: contentId("manifest", manifestBody),
    sourceUri: fixturePath,
    sourceSha256: manifestBody.sourceSha256,
    normalizerVersion: NORMALIZER_VERSION,
    sampleRateHz: SAMPLE_RATE_HZ,
    entries,
    createdAt: "2026-09-01T01:30:00.000Z",
  };

  return { fixture, protocols, trials, signalByTrial, manifest, rawByTrial };
}

function protocolKey(protocolId: string, version: number): string {
  return `${protocolId}@${version}`;
}
