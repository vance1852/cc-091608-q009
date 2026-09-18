import type { MotorTrial, SyncPulse } from "./contracts.js";

export class ClockSyncError extends Error {
  override readonly name = "ClockSyncError";
}

/**
 * 设备时钟 → 墙钟：以该设备的同步脉冲为锚点做线性映射。
 * 左右腕设备的本地时钟互不同步（见 fixtures 中同一墙钟时刻
 * 对应不同的 deviceClockAt），因此任何跨设备比较都必须先
 * 各自对齐到墙钟，禁止直接拼接原始设备时钟。
 */
export function wallClockMsAt(deviceClock: number, pulse: SyncPulse): number {
  return Date.parse(pulse.wallClockAt) + (deviceClock - pulse.deviceClockAt);
}

/** 找到覆盖某试次的同步脉冲，并校验试次记录的脉冲读数一致。 */
export function pulseForTrial(
  trial: MotorTrial,
  pulses: SyncPulse[],
): SyncPulse {
  const pulse = pulses.find((p) => p.deviceId === trial.deviceId);
  if (!pulse) {
    throw new ClockSyncError(
      `trial ${trial.trialId}: 设备 ${trial.deviceId} 没有同步脉冲，无法对齐墙钟`,
    );
  }
  if (pulse.deviceClockAt !== trial.syncPulseAt) {
    throw new ClockSyncError(
      `trial ${trial.trialId}: 记录的 syncPulseAt=${trial.syncPulseAt} 与设备 ${trial.deviceId} 的脉冲 ${pulse.deviceClockAt} 不一致`,
    );
  }
  return pulse;
}

export function trialStartWallClockMs(
  trial: MotorTrial,
  pulses: SyncPulse[],
): number {
  return wallClockMsAt(trial.deviceClockStart, pulseForTrial(trial, pulses));
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** 服药相位：试次开始的墙钟时刻距服药时刻的分钟数。 */
export function medicationPhaseMinutes(
  trial: MotorTrial,
  pulses: SyncPulse[],
): number {
  const startMs = trialStartWallClockMs(trial, pulses);
  const medMs = Date.parse(trial.medicationTakenAt);
  if (Number.isNaN(medMs)) {
    throw new ClockSyncError(
      `trial ${trial.trialId}: medicationTakenAt 无法解析: ${trial.medicationTakenAt}`,
    );
  }
  return round2((startMs - medMs) / 60_000);
}
