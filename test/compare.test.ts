import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  aggregateSameScope,
  AggregationError,
  createCurationSet,
  verifyManifest,
  type SummaryEntry,
} from "../src/index.js";
import { ALGO_V1, NOW, PARAMS_V1, serviceWithFixture } from "./helpers.js";

function prepareSignedSummaries(service: ReturnType<typeof serviceWithFixture>) {
  const curation = createCurationSet({
    visitId: "v2",
    version: 1,
    decisions: [
      {
        decisionId: "d1",
        kind: "exclude-segment",
        targetId: "v2-left-rest-seg2",
        reason: "运动伪差",
        decidedBy: "therapist-wang",
        decidedAt: "2026-09-01T11:20:00+08:00",
      },
      {
        decisionId: "d2",
        kind: "confirm-make-up",
        targetId: "v2-walk-b",
        reason: "补做完整",
        decidedBy: "therapist-wang",
        decidedAt: "2026-09-01T11:25:00+08:00",
      },
    ],
    createdAt: NOW,
  });
  service.registerCuration(curation);

  const runV1 = service.runAssessment({
    visitId: "v1",
    curationId: null,
    algorithmVersion: ALGO_V1,
    parameterVersion: PARAMS_V1,
    now: NOW,
  });
  const runV2 = service.runAssessment({
    visitId: "v2",
    curationId: curation.curationId,
    algorithmVersion: ALGO_V1,
    parameterVersion: PARAMS_V1,
    now: NOW,
  });
  const sumV1 = service.signAndStore(
    service.draftSummary({
      visitId: "v1",
      curationId: null,
      runId: runV1.result.run.runId,
      now: NOW,
    }),
    "dr-chen",
    NOW,
  );
  const sumV2 = service.signAndStore(
    service.draftSummary({
      visitId: "v2",
      curationId: curation.curationId,
      runId: runV2.result.run.runId,
      now: NOW,
    }),
    "dr-chen",
    NOW,
  );
  return { sumV1, sumV2 };
}

describe("访视比较", () => {
  it("逐 任务×侧 成行，绝不跨侧合并", () => {
    const service = serviceWithFixture();
    const { sumV1, sumV2 } = prepareSignedSummaries(service);
    const comparison = service.compareSigned({
      baselineSummaryId: sumV1.summaryId,
      followUpSummaryId: sumV2.summaryId,
      now: NOW,
    });
    // 4 个任务 × 2 侧 = 8 行
    assert.equal(comparison.rows.length, 8);
    const keys = comparison.rows.map((r) => `${r.task}/${r.side}`);
    assert.equal(new Set(keys).size, 8);
  });

  it("服药相位不一致被明确标出，分数差不给出", () => {
    const service = serviceWithFixture();
    const { sumV1, sumV2 } = prepareSignedSummaries(service);
    const comparison = service.compareSigned({
      baselineSummaryId: sumV1.summaryId,
      followUpSummaryId: sumV2.summaryId,
      now: NOW,
    });
    const restLeft = comparison.rows.find(
      (r) => r.task === "rest" && r.side === "left",
    )!;
    // 分数看似下降（0.85 → 0.60）
    assert.ok(restLeft.followUp!.value < restLeft.baseline!.value);
    // 但相位差 90 分钟，超过 ±30 容差 → 不可比较，不给 delta
    assert.equal(restLeft.comparable, false);
    assert.equal(restLeft.delta, null);
    const issue = restLeft.issues.find(
      (i) => i.code === "medication-phase-mismatch",
    )!;
    assert.match(issue.detail, /90/);
    assert.match(issue.detail, /60/);
    assert.match(issue.detail, /150/);
  });

  it("提示节拍版本不同被标为方案不一致", () => {
    const service = serviceWithFixture();
    const { sumV1, sumV2 } = prepareSignedSummaries(service);
    const comparison = service.compareSigned({
      baselineSummaryId: sumV1.summaryId,
      followUpSummaryId: sumV2.summaryId,
      now: NOW,
    });
    const walkLeft = comparison.rows.find(
      (r) => r.task === "walk" && r.side === "left",
    )!;
    assert.equal(walkLeft.comparable, false);
    const issue = walkLeft.issues.find(
      (i) => i.code === "protocol-spec-mismatch",
    )!;
    assert.match(issue.detail, /metronome-1\.0/);
    assert.match(issue.detail, /metronome-2\.0/);
  });

  it("相位与方案对齐时给出可比较的 delta", () => {
    const service = serviceWithFixture();
    const { sumV1 } = prepareSignedSummaries(service);
    // 同一访视自比：相位差 0、方案一致 → 全部可比较且 delta 为 0
    const comparison = service.compareSigned({
      baselineSummaryId: sumV1.summaryId,
      followUpSummaryId: sumV1.summaryId,
      now: NOW,
    });
    assert.ok(comparison.rows.every((r) => r.comparable));
    assert.ok(comparison.rows.every((r) => r.delta === 0));
  });

  it("缺少可用试次的行被标出原因", () => {
    const service = serviceWithFixture();
    const curation = createCurationSet({
      visitId: "v2",
      version: 1,
      decisions: [
        {
          decisionId: "d1",
          kind: "exclude-trial",
          targetId: "v2-left-rest",
          reason: "佩戴松动",
          decidedBy: "therapist-wang",
          decidedAt: NOW,
        },
      ],
      createdAt: NOW,
    });
    service.registerCuration(curation);
    const runV1 = service.runAssessment({
      visitId: "v1",
      curationId: null,
      algorithmVersion: ALGO_V1,
      parameterVersion: PARAMS_V1,
      now: NOW,
    });
    const runV2 = service.runAssessment({
      visitId: "v2",
      curationId: curation.curationId,
      algorithmVersion: ALGO_V1,
      parameterVersion: PARAMS_V1,
      now: NOW,
    });
    const sumV1 = service.signAndStore(
      service.draftSummary({
        visitId: "v1",
        curationId: null,
        runId: runV1.result.run.runId,
        now: NOW,
      }),
      "dr-chen",
      NOW,
    );
    const sumV2 = service.signAndStore(
      service.draftSummary({
        visitId: "v2",
        curationId: curation.curationId,
        runId: runV2.result.run.runId,
        now: NOW,
      }),
      "dr-chen",
      NOW,
    );
    const comparison = service.compareSigned({
      baselineSummaryId: sumV1.summaryId,
      followUpSummaryId: sumV2.summaryId,
      now: NOW,
    });
    const restLeft = comparison.rows.find(
      (r) => r.task === "rest" && r.side === "left",
    )!;
    assert.equal(restLeft.comparable, false);
    assert.ok(restLeft.issues.some((i) => i.code === "no-usable-trial"));
  });
});

describe("聚合守卫", () => {
  function entry(partial: Partial<SummaryEntry>): SummaryEntry {
    return {
      task: "rest",
      side: "left",
      protocolVersion: 2,
      metric: "tremor-score",
      value: 1,
      unit: "g^2/Hz",
      runId: "run-x",
      trialId: "t-x",
      segmentIds: ["s1"],
      medicationPhaseMinutes: 60,
      algorithmVersion: ALGO_V1,
      parameterVersion: PARAMS_V1,
      ...partial,
    };
  }

  it("禁止跨腕侧聚合", () => {
    assert.throws(
      () => aggregateSameScope([entry({}), entry({ side: "right" })]),
      AggregationError,
    );
  });

  it("禁止跨方案版本聚合", () => {
    assert.throws(
      () =>
        aggregateSameScope([entry({}), entry({ protocolVersion: 3 })]),
      AggregationError,
    );
  });

  it("同任务同侧同方案的条目可以聚合", () => {
    const mean = aggregateSameScope([
      entry({ value: 1 }),
      entry({ value: 3, trialId: "t-y" }),
    ]);
    assert.equal(mean, 2);
  });
});

describe("审阅者追溯", () => {
  it("从分数可回溯到试次、信号区间与处理版本", () => {
    const service = serviceWithFixture();
    const { sumV2 } = prepareSignedSummaries(service);
    const lineage = service.store.traceScore(sumV2.summaryId, "rest", "left");

    assert.equal(lineage.entry.trialId, "v2-left-rest");
    assert.equal(lineage.run.algorithmVersion, ALGO_V1);
    assert.equal(lineage.run.parameterVersion, PARAMS_V1);
    assert.equal(lineage.run.runId, lineage.entry.runId);
    assert.deepEqual(
      lineage.trials.map((t) => t.trialId),
      ["v2-left-rest"],
    );
    assert.deepEqual(
      lineage.segments.map((s) => s.segmentId),
      ["v2-left-rest-seg1"],
    );
    assert.equal(lineage.protocol.version, 3);
    assert.equal(lineage.curation?.curationId, sumV2.curationId);
    assert.equal(lineage.entry.medicationPhaseMinutes, 150);
    // 清单中登记了该试次与片段的内容哈希
    const itemIds = lineage.manifest.items.map((i) => i.id);
    assert.ok(itemIds.includes("v2-left-rest"));
    assert.ok(itemIds.includes("v2-left-rest-seg1"));
    assert.ok(itemIds.includes("pd-motor@3"));
    // 重建运行输入后，整个清单复核通过
    const inputs = service.inputsForRun(lineage.run.runId);
    assert.equal(verifyManifest(lineage.manifest, inputs).ok, true);
  });
});
