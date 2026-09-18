import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildManifest,
  UnknownVersionError,
  verifyManifest,
} from "../src/index.js";
import { ALGO_V1, NOW, PARAMS_V1, serviceWithFixture } from "./helpers.js";

describe("不可变输入清单与算法运行", () => {
  it("同一输入重算得到同一 runId，安全复用，不重复登记", () => {
    const service = serviceWithFixture();
    const args = {
      visitId: "v1",
      curationId: null,
      algorithmVersion: ALGO_V1,
      parameterVersion: PARAMS_V1,
      now: NOW,
    };
    const first = service.runAssessment(args);
    const second = service.runAssessment(args);
    assert.equal(second.result.run.runId, first.result.run.runId);
    assert.equal(second.result.reused, true);
    assert.equal(service.store.runs.size, 1);
    assert.deepEqual(
      second.result.outputs.map((o) => [o.trialId, o.value]),
      first.result.outputs.map((o) => [o.trialId, o.value]),
    );
  });

  it("清单哈希与输入顺序无关", () => {
    const service = serviceWithFixture();
    const visit = service.store.visit("v1");
    const protocol = service.store.protocol("pd-motor", 2);
    const segments = [...visit.segmentsByTrial.values()].flat();
    const a = buildManifest({
      trials: visit.trials,
      segments,
      protocol,
      curationId: null,
      algorithmVersion: ALGO_V1,
      parameterVersion: PARAMS_V1,
    });
    const b = buildManifest({
      trials: [...visit.trials].reverse(),
      segments: [...segments].reverse(),
      protocol,
      curationId: null,
      algorithmVersion: ALGO_V1,
      parameterVersion: PARAMS_V1,
    });
    assert.equal(a.manifestHash, b.manifestHash);
  });

  it("原始信号被改动后清单复核失败", () => {
    const service = serviceWithFixture();
    const visit = service.store.visit("v1");
    const protocol = service.store.protocol("pd-motor", 2);
    const segments = [...visit.segmentsByTrial.values()].flat();
    const manifest = buildManifest({
      trials: visit.trials,
      segments,
      protocol,
      curationId: null,
      algorithmVersion: ALGO_V1,
      parameterVersion: PARAMS_V1,
    });
    const tampered = segments.map((s, i) =>
      i === 0 ? { ...s, samples: s.samples.map((x) => x * 10) } : s,
    );
    const check = verifyManifest(manifest, {
      trials: visit.trials,
      segments: tampered,
      protocol,
    });
    assert.equal(check.ok, false);
    assert.ok(check.mismatches.some((m) => m.includes(segments[0]!.segmentId)));
  });

  it("新算法版本产生新运行，与旧结果并列，旧结果不变", () => {
    const service = serviceWithFixture();
    const oldRun = service.runAssessment({
      visitId: "v2",
      curationId: null,
      algorithmVersion: ALGO_V1,
      parameterVersion: PARAMS_V1,
      now: NOW,
    });
    const newRun = service.runAssessment({
      visitId: "v2",
      curationId: null,
      algorithmVersion: "tremor-rms/1.1.0",
      parameterVersion: "params-2026.09",
      now: NOW,
    });
    assert.notEqual(newRun.result.run.runId, oldRun.result.run.runId);
    assert.equal(service.store.runs.size, 2);
    const ids = service.store.runs.list().map((r) => r.runId);
    assert.ok(ids.includes(oldRun.result.run.runId));
    assert.ok(ids.includes(newRun.result.run.runId));
    // 旧运行的输出仍可按 runId 原样取回
    const oldOutputs = service.store.runs.outputsOf(oldRun.result.run.runId);
    assert.deepEqual(
      oldOutputs.map((o) => o.value),
      oldRun.result.outputs.map((o) => o.value),
    );
  });

  it("未注册的算法或参数版本被拒绝", () => {
    const service = serviceWithFixture();
    assert.throws(
      () =>
        service.runAssessment({
          visitId: "v1",
          curationId: null,
          algorithmVersion: "tremor-rms/9.9.9",
          parameterVersion: PARAMS_V1,
          now: NOW,
        }),
      UnknownVersionError,
    );
    assert.throws(
      () =>
        service.runAssessment({
          visitId: "v1",
          curationId: null,
          algorithmVersion: ALGO_V1,
          parameterVersion: "params-1900.01",
          now: NOW,
        }),
      UnknownVersionError,
    );
  });
});
