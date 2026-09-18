import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ClockSyncError,
  medicationPhaseMinutes,
  pulseForTrial,
  trialStartWallClockMs,
} from "../src/index.js";
import { loadFixture } from "./helpers.js";

describe("设备时钟对齐与服药相位", () => {
  const fixture = loadFixture();
  const v1 = fixture.visits.find((v) => v.visitId === "v1")!;
  const v2 = fixture.visits.find((v) => v.visitId === "v2")!;

  it("双腕设备时钟不同步，但经各自同步脉冲对齐后落在同一墙钟时刻", () => {
    const left = v1.trials.find((t) => t.trialId === "v1-left-rest")!;
    const right = v1.trials.find((t) => t.trialId === "v1-right-rest")!;
    // 原始设备时钟相差 160ms（不同步的直接证据）
    assert.equal(left.deviceClockStart - right.deviceClockStart, -160);
    // 对齐后两侧同为 09:00:00.000 墙钟
    assert.equal(
      trialStartWallClockMs(left, v1.pulses),
      trialStartWallClockMs(right, v1.pulses),
    );
  });

  it("服药相位按对齐后的墙钟计算", () => {
    const v1Rest = v1.trials.find((t) => t.trialId === "v1-left-rest")!;
    const v2Rest = v2.trials.find((t) => t.trialId === "v2-left-rest")!;
    assert.equal(medicationPhaseMinutes(v1Rest, v1.pulses), 60);
    assert.equal(medicationPhaseMinutes(v2Rest, v2.pulses), 150);
  });

  it("试次记录的同步脉冲读数与设备脉冲不一致时拒绝对齐", () => {
    const trial = v1.trials.find((t) => t.trialId === "v1-left-rest")!;
    const tampered = { ...trial, syncPulseAt: 9999 };
    assert.throws(() => pulseForTrial(tampered, v1.pulses), ClockSyncError);
  });
});
