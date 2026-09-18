import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createCurationSet,
  SummaryError,
  verifySummary,
  type ClinicalSummary,
} from "../src/index.js";
import { ALGO_V1, NOW, PARAMS_V1, serviceWithFixture } from "./helpers.js";

const CURATION_DECISIONS = [
  {
    decisionId: "d1",
    kind: "exclude-segment" as const,
    targetId: "v2-left-rest-seg2",
    reason: "运动伪差",
    decidedBy: "therapist-wang",
    decidedAt: "2026-09-01T11:20:00+08:00",
  },
  {
    decisionId: "d2",
    kind: "confirm-make-up" as const,
    targetId: "v2-walk-b",
    reason: "补做完整",
    decidedBy: "therapist-wang",
    decidedAt: "2026-09-01T11:25:00+08:00",
  },
];

function registerV2Curation(service: ReturnType<typeof serviceWithFixture>) {
  const set = createCurationSet({
    visitId: "v2",
    version: 1,
    decisions: CURATION_DECISIONS,
    createdAt: NOW,
  });
  service.registerCuration(set);
  return set;
}

describe("治疗师裁量", () => {
  it("中断试次默认不可用，补做试次确认前也不可用", () => {
    const service = serviceWithFixture();
    const view = service.curate("v2", null);
    const ids = view.trials.map((c) => c.trial.trialId);
    assert.ok(!ids.includes("v2-walk-a"));
    assert.ok(!ids.includes("v2-walk-b"));
    const reasons = new Map(view.dropped.map((d) => [d.trialId, d.reason]));
    assert.match(reasons.get("v2-walk-a") ?? "", /中断/);
    assert.match(reasons.get("v2-walk-b") ?? "", /未经治疗师确认/);
  });

  it("确认补做后补做试次可用，中断试次仍不可用", () => {
    const service = serviceWithFixture();
    const set = registerV2Curation(service);
    const view = service.curate("v2", set.curationId);
    const ids = view.trials.map((c) => c.trial.trialId);
    assert.ok(ids.includes("v2-walk-b"));
    assert.ok(!ids.includes("v2-walk-a"));
  });

  it("排除伪差片段改变该试次的输入与指标", () => {
    const service = serviceWithFixture();
    const set = registerV2Curation(service);
    const before = service.curate("v2", null);
    const after = service.curate("v2", set.curationId);
    const restBefore = before.trials.find(
      (c) => c.trial.trialId === "v2-left-rest",
    )!;
    const restAfter = after.trials.find(
      (c) => c.trial.trialId === "v2-left-rest",
    )!;
    assert.deepEqual(
      restBefore.segments.map((s) => s.segmentId),
      ["v2-left-rest-seg1", "v2-left-rest-seg2"],
    );
    assert.deepEqual(
      restAfter.segments.map((s) => s.segmentId),
      ["v2-left-rest-seg1"],
    );

    const runBefore = service.runAssessment({
      visitId: "v2",
      curationId: null,
      algorithmVersion: ALGO_V1,
      parameterVersion: PARAMS_V1,
      now: NOW,
    });
    const runAfter = service.runAssessment({
      visitId: "v2",
      curationId: set.curationId,
      algorithmVersion: ALGO_V1,
      parameterVersion: PARAMS_V1,
      now: NOW,
    });
    const valueOf = (outputs: typeof runBefore.result.outputs) =>
      outputs.find((o) => o.trialId === "v2-left-rest")!.value;
    // 混入伪差片段时分数显著虚高，排除后回落
    assert.ok(valueOf(runBefore.result.outputs) > 1.4);
    assert.ok(valueOf(runAfter.result.outputs) < 0.7);
    // 输入清单不同 → 不同的运行记录，二者并列
    assert.notEqual(runBefore.result.run.runId, runAfter.result.run.runId);
    assert.equal(service.store.runs.size, 2);
  });
});

describe("临床摘要签署", () => {
  function signedV2Summary(service: ReturnType<typeof serviceWithFixture>) {
    const set = registerV2Curation(service);
    const run = service.runAssessment({
      visitId: "v2",
      curationId: set.curationId,
      algorithmVersion: ALGO_V1,
      parameterVersion: PARAMS_V1,
      now: NOW,
    });
    const draft = service.draftSummary({
      visitId: "v2",
      curationId: set.curationId,
      runId: run.result.run.runId,
      now: NOW,
    });
    return service.signAndStore(draft, "dr-chen", "2026-09-01T11:45:00+08:00");
  }

  it("签署后摘要冻结且校验通过，不能重复签署", () => {
    const service = serviceWithFixture();
    const signed = signedV2Summary(service);
    assert.equal(signed.status, "signed");
    assert.equal(verifySummary(signed), true);
    assert.ok(Object.isFrozen(signed));
    assert.ok(Object.isFrozen(signed.entries));
    assert.throws(
      () => service.signAndStore(signed, "dr-chen", NOW),
      SummaryError,
    );
  });

  it("重算（新算法、新运行）不改变已签署摘要", () => {
    const service = serviceWithFixture();
    const signed = signedV2Summary(service);
    const hashBefore = signed.contentHash;
    const entriesBefore = JSON.stringify(signed.entries);

    service.runAssessment({
      visitId: "v2",
      curationId: signed.curationId,
      algorithmVersion: "tremor-rms/1.1.0",
      parameterVersion: "params-2026.09",
      now: "2026-09-10T09:00:00+08:00",
    });

    const stored = service.store.summary(signed.summaryId);
    assert.equal(stored.contentHash, hashBefore);
    assert.equal(JSON.stringify(stored.entries), entriesBefore);
    assert.equal(verifySummary(stored), true);
    // 新旧运行并列保留
    assert.equal(service.store.runs.size, 2);
  });

  it("内容被篡改的摘要校验失败", () => {
    const service = serviceWithFixture();
    const signed = signedV2Summary(service);
    const tampered: ClinicalSummary = {
      ...signed,
      entries: signed.entries.map((e, i) =>
        i === 0 ? { ...e, value: e.value / 2 } : e,
      ),
    };
    assert.equal(verifySummary(tampered), false);
  });

  it("裁量调整形成新的摘要版本而非改写旧摘要", () => {
    const service = serviceWithFixture();
    const first = signedV2Summary(service);

    // 治疗师进一步排除一个试次 → 新裁量集 v2 → 新运行 → 新摘要
    const set2 = createCurationSet({
      visitId: "v2",
      version: 2,
      decisions: [
        ...CURATION_DECISIONS,
        {
          decisionId: "d3",
          kind: "exclude-trial" as const,
          targetId: "v2-left-posture",
          reason: "患者未保持姿势",
          decidedBy: "therapist-wang",
          decidedAt: "2026-09-02T09:00:00+08:00",
        },
      ],
      supersedes: first.curationId,
      createdAt: "2026-09-02T09:05:00+08:00",
    });
    service.registerCuration(set2);
    const run2 = service.runAssessment({
      visitId: "v2",
      curationId: set2.curationId,
      algorithmVersion: ALGO_V1,
      parameterVersion: PARAMS_V1,
      now: "2026-09-02T09:10:00+08:00",
    });
    const second = service.signAndStore(
      service.draftSummary({
        visitId: "v2",
        curationId: set2.curationId,
        runId: run2.result.run.runId,
        now: "2026-09-02T09:15:00+08:00",
        supersedes: first.summaryId,
      }),
      "dr-chen",
      "2026-09-02T09:20:00+08:00",
    );

    assert.equal(second.supersedes, first.summaryId);
    assert.notEqual(second.contentHash, first.contentHash);
    // 旧摘要仍在库中且未被改写
    assert.equal(verifySummary(service.store.summary(first.summaryId)), true);
    assert.ok(
      !second.entries.some(
        (e) => e.task === "posture" && e.side === "left",
      ),
    );
  });
});
