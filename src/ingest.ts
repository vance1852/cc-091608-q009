import type {
  MotorTask,
  MotorTrial,
  ProtocolVersion,
  SignalSegment,
  SyncPulse,
  TrialStatus,
  WristSide,
} from "./contracts.js";
import type { VisitRecord } from "./store.js";

export class IngestError extends Error {
  override readonly name = "IngestError";
}

export interface FixtureData {
  patientId: string;
  protocols: ProtocolVersion[];
  visits: VisitRecord[];
}

const TASKS: MotorTask[] = ["rest", "posture", "pronation-supination", "walk"];
const SIDES: WristSide[] = ["left", "right"];
const STATUSES: TrialStatus[] = ["completed", "interrupted", "make-up"];

function fail(path: string, msg: string): never {
  throw new IngestError(`${path}: ${msg}`);
}

function asObject(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "应为对象");
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) fail(path, "应为非空字符串");
  return value;
}

function asNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "应为有限数值");
  return value;
}

function asStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    fail(path, "应为字符串数组");
  }
  return value as string[];
}

function asEnum<T extends string>(value: unknown, path: string, allowed: T[]): T {
  const s = asString(value, path);
  if (!allowed.includes(s as T)) fail(path, `应为 ${allowed.join("/")} 之一，实际为 ${s}`);
  return s as T;
}

function parseProtocol(raw: unknown, path: string): ProtocolVersion {
  const o = asObject(raw, path);
  const tasks = (o.tasks as unknown[]).map((t, i) => {
    const to = asObject(t, `${path}.tasks[${i}]`);
    return {
      kind: asEnum(to.kind, `${path}.tasks[${i}].kind`, TASKS),
      durationSeconds: asNumber(to.durationSeconds, `${path}.tasks[${i}].durationSeconds`),
      cueVersion: asString(to.cueVersion, `${path}.tasks[${i}].cueVersion`),
    };
  });
  return {
    protocolId: asString(o.protocolId, `${path}.protocolId`),
    version: asNumber(o.version, `${path}.version`),
    tasks,
    publishedAt: asString(o.publishedAt, `${path}.publishedAt`),
  };
}

function parsePulse(raw: unknown, path: string): SyncPulse {
  const o = asObject(raw, path);
  return {
    deviceId: asString(o.deviceId, `${path}.deviceId`),
    deviceClockAt: asNumber(o.deviceClockAt, `${path}.deviceClockAt`),
    wallClockAt: asString(o.wallClockAt, `${path}.wallClockAt`),
  };
}

function parseSegment(raw: unknown, path: string): SignalSegment {
  const o = asObject(raw, path);
  const samplesRaw = o.samples;
  if (!Array.isArray(samplesRaw) || samplesRaw.length === 0) {
    fail(`${path}.samples`, "应为非空数值数组");
  }
  const samples = samplesRaw.map((s, i) => asNumber(s, `${path}.samples[${i}]`));
  return {
    segmentId: asString(o.segmentId, `${path}.segmentId`),
    trialId: asString(o.trialId, `${path}.trialId`),
    deviceClockStart: asNumber(o.deviceClockStart, `${path}.deviceClockStart`),
    deviceClockEnd: asNumber(o.deviceClockEnd, `${path}.deviceClockEnd`),
    samples,
    deviations: asStringArray(o.deviations ?? [], `${path}.deviations`),
  };
}

function parseVisit(raw: unknown, path: string): VisitRecord {
  const o = asObject(raw, path);
  const visitId = asString(o.visitId, `${path}.visitId`);
  const medicationTakenAt = asString(o.medicationTakenAt, `${path}.medicationTakenAt`);
  const protocolId = asString(o.protocolId, `${path}.protocolId`);
  const protocolVersion = asNumber(o.protocolVersion, `${path}.protocolVersion`);

  const pulsesRaw = o.syncPulses;
  if (!Array.isArray(pulsesRaw) || pulsesRaw.length === 0) {
    fail(`${path}.syncPulses`, "访视必须携带同步脉冲");
  }
  const pulses = pulsesRaw.map((p, i) => parsePulse(p, `${path}.syncPulses[${i}]`));

  const trialsRaw = o.trials;
  if (!Array.isArray(trialsRaw) || trialsRaw.length === 0) {
    fail(`${path}.trials`, "访视必须包含试次");
  }
  const trials: MotorTrial[] = trialsRaw.map((t, i) => {
    const tp = `${path}.trials[${i}]`;
    const to = asObject(t, tp);
    const status = asEnum(to.status, `${tp}.status`, STATUSES);
    const trial: MotorTrial = {
      trialId: asString(to.trialId, `${tp}.trialId`),
      visitId,
      task: asEnum(to.task, `${tp}.task`, TASKS),
      side: asEnum(to.side, `${tp}.side`, SIDES),
      medicationTakenAt,
      deviceClockStart: asNumber(to.deviceClockStart, `${tp}.deviceClockStart`),
      syncPulseAt: asNumber(to.syncPulseAt, `${tp}.syncPulseAt`),
      deviations: asStringArray(to.deviations ?? [], `${tp}.deviations`),
      deviceId: asString(to.deviceId, `${tp}.deviceId`),
      status,
    };
    if (to.makesUpTrialId !== undefined) {
      trial.makesUpTrialId = asString(to.makesUpTrialId, `${tp}.makesUpTrialId`);
    }
    if (status === "make-up" && trial.makesUpTrialId === undefined) {
      fail(tp, "补做试次必须指明 makesUpTrialId");
    }
    return trial;
  });

  const segmentsByTrial = new Map<string, SignalSegment[]>();
  const segmentsRaw = o.segments;
  if (!Array.isArray(segmentsRaw)) fail(`${path}.segments`, "应为数组");
  const trialIds = new Set(trials.map((t) => t.trialId));
  for (const [i, s] of segmentsRaw.entries()) {
    const segment = parseSegment(s, `${path}.segments[${i}]`);
    if (!trialIds.has(segment.trialId)) {
      fail(`${path}.segments[${i}]`, `信号区间指向未知试次 ${segment.trialId}`);
    }
    const list = segmentsByTrial.get(segment.trialId) ?? [];
    list.push(segment);
    segmentsByTrial.set(segment.trialId, list);
  }

  return {
    visitId,
    protocolId,
    protocolVersion,
    medicationTakenAt,
    pulses,
    trials,
    segmentsByTrial,
  };
}

/** 解析并校验 fixture/采集端上报的 JSON，失败时抛出带路径的错误。 */
export function parseFixture(raw: unknown): FixtureData {
  const o = asObject(raw, "$");
  const protocolsRaw = o.protocols;
  if (!Array.isArray(protocolsRaw) || protocolsRaw.length === 0) {
    fail("$.protocols", "应为非空数组");
  }
  const visitsRaw = o.visits;
  if (!Array.isArray(visitsRaw) || visitsRaw.length === 0) {
    fail("$.visits", "应为非空数组");
  }
  return {
    patientId: asString(o.patientId, "$.patientId"),
    protocols: protocolsRaw.map((p, i) => parseProtocol(p, `$.protocols[${i}]`)),
    visits: visitsRaw.map((v, i) => parseVisit(v, `$.visits[${i}]`)),
  };
}
