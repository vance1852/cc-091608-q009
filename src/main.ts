import { mkdirSync, writeFileSync } from "node:fs";
import { runMetrics } from "./algorithm.js";
import { buildClinicalSummary, createReview, createSigner, openSignedSummary, signSummary } from "./clinical.js";
import { compareVisits } from "./comparison.js";
import { sha256Bytes, sha256Hex } from "./canonical.js";
import { ingest, NORMALIZER_VERSION } from "./ingest.js";
import { getParameterSet } from "./parameters.js";
import { AssessmentRegistry } from "./registry.js";
import type {
  ClinicalSummary,
  DerivedMetric,
  MetricRun,
  MotorTrial,
  TremorMetrics,
  VisitComparisonReport,
} from "./contracts.js";

// ── 极简断言 ───────────────────────────────────────────────────────────────

let checks = 0;
function assert(cond: boolean, message: string): void {
  checks++;
  if (!cond) throw new Error(`断言失败：${message}`);
  console.log(`  ✓ ${message}`);
}

function metricOf(metrics: DerivedMetric[], trialId: string): DerivedMetric {
  const m = metrics.find((x) => x.trialId === trialId);
  if (!m) throw new Error(`missing metric for ${trialId}`);
  return m;
}

// ── 1. 不可变原始证据入库：原始 fixture → 规范化试次 + 输入清单 ─────────────

console.log("═══ 1. 采集规范化与不可变输入清单 ═══");
const fixturePath = new URL("../fixtures/motor-assessments.json", import.meta.url).pathname;
const ingested = ingest(fixturePath);
const registry = new AssessmentRegistry();
registry.addProtocols(ingested.protocols);
registry.addTrials(ingested.trials, ingested.rawByTrial);
registry.addManifest(ingested.manifest);

console.log(`  输入清单 ${ingested.manifest.manifestId}`);
console.log(`  源文件 sha256: ${ingested.manifest.sourceSha256}`);
console.log(`  规范化程序: ${NORMALIZER_VERSION}，试次 ${ingested.manifest.entries.length} 个`);

// 双腕不同步的证据：同一临床时刻的脉冲，两只设备读数相差 160ms，各自独立锚定。
const leftRest = ingested.trials.find((t) => t.trialId === "v1-left-rest")!;
const rightRest = ingested.trials.find((t) => t.trialId === "v1-right-rest")!;
const rawLeft = ingested.rawByTrial.get("v1-left-rest")!;
const rawRight = ingested.rawByTrial.get("v1-right-rest")!;
console.log(`  v1 左腕脉冲读数=${rawLeft.syncPulseAt} 右腕=${rawRight.syncPulseAt}（设备时钟不同步，相差 160ms）`);
console.log(`  锚定后临床起点 左=${leftRest.clinicalStartAt} 右=${rightRest.clinicalStartAt}`);
assert(
  Math.abs(Date.parse(leftRest.clinicalStartAt) - Date.parse(rightRest.clinicalStartAt)) === 160,
  "左右腕通过各自同步脉冲独立锚定，保留 160ms 真实偏差而非强行对齐",
);

const inputs = new Map(
  ingested.trials.map((t) => [
    t.trialId,
    { trial: t, signalBytes: ingested.signalByTrial.get(t.trialId)! },
  ]),
);

// ── 2. 算法运行：引用清单与参数版本；同输入安全重算 ─────────────────────────

console.log("\n═══ 2. 版本化算法运行（新老结果并列） ═══");
const paramsV1 = getParameterSet("tremor-params-1");

const run1 = runMetrics("tremor-algo-1.0.0", paramsV1, ingested.manifest, inputs, "2026-09-01T02:00:00.000Z");
registry.addRun(run1.run, run1.metrics);
console.log(`  run A: ${run1.run.runId}（tremor-algo-1.0.0 / tremor-params-1）→ ${run1.metrics.length} 个指标`);

// 立即重算：内容寻址，ID 必须完全一致（不产生重复、不覆盖旧结果）。
const run1Again = runMetrics("tremor-algo-1.0.0", paramsV1, ingested.manifest, inputs, "2026-09-02T00:00:00.000Z");
assert(run1Again.run.runId === run1.run.runId, "同一输入重算得到相同 runId（createdAt 不参与身份）");
assert(
  run1Again.metrics.every((m, i) => m.metricId === run1.metrics[i]!.metricId && m.value.tremorScore === run1.metrics[i]!.value.tremorScore),
  "同一输入重算得到逐试次一致的指标与分数",
);

// 新版本算法：结果与旧版本并列，不替换。
const run2 = runMetrics("tremor-algo-1.1.0", paramsV1, ingested.manifest, inputs, "2026-09-01T02:10:00.000Z");
registry.addRun(run2.run, run2.metrics);
console.log(`  run B: ${run2.run.runId}（tremor-algo-1.1.0 / tremor-params-1）与 run A 并列保存`);
assert(run2.run.runId !== run1.run.runId, "不同算法版本产生不同 run，旧 run 保留");
const aScore = metricOf(run1.metrics, "v1-left-rest").value.tremorScore;
const bScore = metricOf(run2.metrics, "v1-left-rest").value.tremorScore;
console.log(`  同一试次 v1-left-rest：algo-1.0 分数=${aScore}，algo-1.1 分数=${bScore}（三轴合成）`);
assert(aScore !== bScore, "两版算法对同一试次给出各自分数，互不覆盖");

// 清单防篡改：改动信号字节必须被运行前校验拒绝。
const tampered = new Map(inputs);
tampered.set("v1-left-rest", {
  trial: inputs.get("v1-left-rest")!.trial,
  signalBytes: Buffer.concat([inputs.get("v1-left-rest")!.signalBytes, Buffer.from([0])]),
});
let rejected = false;
try {
  runMetrics("tremor-algo-1.0.0", paramsV1, ingested.manifest, tampered, "2026-09-01T02:00:00.000Z");
} catch {
  rejected = true;
}
assert(rejected, "信号字节与清单 sha256 不一致时拒绝运行");

// ── 3. 治疗师复核：排除中断片段、确认补做 ──────────────────────────────────

console.log("\n═══ 3. 治疗师复核（协议偏差与真实采用分开） ═══");
const reviewExcludeWalk = createReview({
  trialId: "v2-walk-a",
  decision: "exclude",
  reason: "步行段遇障碍物中断，仅采集 12/30 秒，排除该片段",
  reviewerId: "therapist-chen",
  decidedAt: "2026-09-01T10:00:00+08:00",
});
const reviewConfirmMakeup = createReview({
  trialId: "v2-walk-b",
  decision: "confirm-make-up",
  reason: "补做步行段流程完整、无偏差，确认为该任务/侧别的正式试次",
  reviewerId: "therapist-chen",
  decidedAt: "2026-09-01T10:02:00+08:00",
});
const reviewKeepPosture = createReview({
  trialId: "v2-left-posture",
  decision: "include",
  reason: "咳嗽出现在段末，完成度满足要求，保留试次但偏差留痕",
  reviewerId: "therapist-chen",
  decidedAt: "2026-09-01T10:03:00+08:00",
});
for (const r of [reviewExcludeWalk, reviewConfirmMakeup, reviewKeepPosture]) registry.addReview(r);
console.log(`  复核记录：${reviewExcludeWalk.reviewId}（排除）、${reviewConfirmMakeup.reviewId}（确认补做）`);

// ── 4. 形成临床摘要并签署 ──────────────────────────────────────────────────

console.log("\n═══ 4. 临床摘要与签署 ═══");
const v1Trials = ingested.trials.filter((t) => t.visitId === "v1");
const v2Trials = ingested.trials.filter((t) => t.visitId === "v2");

const summaryV1 = buildClinicalSummary({
  patientId: "motor-18",
  authorId: "therapist-chen",
  createdAt: "2026-09-01T10:05:00+08:00",
  note: "首次评估，双腕各任务完成",
  visitTrials: v1Trials,
  run: run1.run,
  runMetrics: run1.metrics,
  reviews: [],
});
const summaryV2 = buildClinicalSummary({
  patientId: "motor-18",
  authorId: "therapist-chen",
  createdAt: "2026-09-01T10:06:00+08:00",
  note: "复诊；步行首试中断被排除，补做已确认",
  visitTrials: v2Trials,
  run: run1.run,
  runMetrics: run1.metrics,
  reviews: [reviewExcludeWalk, reviewConfirmMakeup, reviewKeepPosture],
});
registry.addSummary(summaryV1);
registry.addSummary(summaryV2);

const walkSelection = summaryV2.selections.find((s) => s.task === "walk");
const walkExclusion = summaryV2.exclusions.find((e) => e.trialId === "v2-walk-a");
console.log(`  v2 步行选择：${walkSelection?.chosenTrialId}（basis=${walkSelection?.basis}）`);
console.log(`  v2 步行排除：${walkExclusion?.trialId} — ${walkExclusion?.reason}`);
assert(walkSelection?.chosenTrialId === "v2-walk-b" && walkSelection.basis === "confirmed-make-up",
  "补做试次经确认后被采用，中断试次 v2-walk-a 进入排除清单");
assert(walkExclusion !== undefined, "中断片段作为协议偏差单独列示，不进入指标选择");
assert(!summaryV2.selections.some((s) => s.side === "right" && s.task === "walk"),
  "v2 无右腕步行试次：不拼接左腕数据冒充右腕");
assert(summaryV2.selections.every((s) => {
  // 每个(任务,侧别)至多一个选择 —— 结构性保证。
  return summaryV2.selections.filter((x) => x.task === s.task && x.side === s.side).length === 1;
}), "同一任务/佩戴侧至多一个入选试次");

const signer = createSigner("therapist-chen");
const signedV2 = signSummary(summaryV2, signer, "2026-09-01T10:08:00+08:00");
registry.addSigned(signedV2);
const opened = openSignedSummary(signedV2, signer);
assert(opened.verified, "临床摘要 Ed25519 签名与载荷 sha256 校验通过");

// 签署后即便重新运行算法，被签署的字节也不变。
const frozenBefore = signedV2.payloadCanonicalJson;
runMetrics("tremor-algo-1.0.0", paramsV1, ingested.manifest, inputs, "2026-09-05T00:00:00.000Z");
runMetrics("tremor-algo-1.1.0", paramsV1, ingested.manifest, inputs, "2026-09-05T00:01:00.000Z");
assert(sha256Hex(frozenBefore) === signedV2.canonicalSha256, "重算后签署载荷字节保持不变");

// 篡改已签署载荷必须被发现。
const tamperedSigned = { ...signedV2, payloadCanonicalJson: frozenBefore.replace("motor-18", "motor-19") };
assert(openSignedSummary(tamperedSigned, signer).verified === false, "签署载荷被篡改时验签失败");

// ── 5. 跨访视比较：对齐服药相位、提示版本与可比试次 ────────────────────────

console.log("\n═══ 5. 跨访视比较报告 ═══");
const report = compareVisits(registry, summaryV1, summaryV2, "2026-09-01T10:10:00+08:00");

for (const pair of report.pairs) {
  const tag = `${pair.task}/${pair.side}`;
  if (pair.comparable) {
    console.log(`  [可比] ${tag}: ${pair.baseline!.tremorScore} → ${pair.followup!.tremorScore}，Δ=${pair.deltaScore}`);
  } else {
    console.log(`  [不可比] ${tag}: 原始分数 ${pair.baseline?.tremorScore ?? "—"} → ${pair.followup?.tremorScore ?? "—"}` +
      `（rawΔ=${pair.rawDeltaScore ?? "—"}，不得作为疗效证据）`);
    for (const r of pair.reasons) console.log(`       · [${r.code}] ${r.message}`);
  }
  for (const a of pair.advisories) console.log(`       · 提示：${a}`);
}

const restLeft = report.pairs.find((p) => p.task === "rest" && p.side === "left")!;
assert(restLeft.comparable === false, "静息/左腕不可比：不能仅凭分数下降支持调药");
assert(restLeft.deltaScore === null && restLeft.rawDeltaScore !== null,
  "不可比时证据级 Δ 为 null，仅保留原始分数差并附原因");
assert(restLeft.reasons.some((r) => r.code === "medication-phase-shift"),
  "明确标注服药相位偏移（第二次测试在服药后更晚完成）");
const phaseDetail = restLeft.reasons.find((r) => r.code === "medication-phase-shift")!.details!;
console.log(`  静息/左腕相位：v1=${phaseDetail.baselinePhaseMinutes} 分，v2=${phaseDetail.followupPhaseMinutes} 分，相差 ${phaseDetail.shiftMinutes} 分（窗口 ±${phaseDetail.toleranceMinutes}）`);

const prosup = report.pairs.find((p) => p.task === "pronation-supination" && p.side === "left")!;
assert(prosup.reasons.some((r) => r.code === "cue-version-mismatch"),
  "旋前旋后节拍版本不同（metronome-v1 vs v2）被判为不可比");
const rightWalk = report.pairs.find((p) => p.task === "walk" && p.side === "right")!;
assert(rightWalk.reasons.some((r) => r.code === "no-valid-trial-followup"),
  "v2 无右腕步行（中断+补做均为左腕），明确标注复诊缺有效试次，禁止用左腕顶替");

// 用新算法版本生成的复诊摘要与旧版本基线比较：版本不匹配必须拒绝。
const summaryV2Algo11 = buildClinicalSummary({
  patientId: "motor-18",
  authorId: "therapist-chen",
  createdAt: "2026-09-02T09:00:00+08:00",
  visitTrials: v2Trials,
  run: run2.run,
  runMetrics: run2.metrics,
  reviews: [reviewExcludeWalk, reviewConfirmMakeup, reviewKeepPosture],
});
registry.addSummary(summaryV2Algo11);
const crossVersionReport = compareVisits(registry, summaryV1, summaryV2Algo11, "2026-09-02T09:05:00+08:00");
assert(
  crossVersionReport.pairs.every((p) =>
    (!p.baseline || !p.followup) ||
    (!p.comparable && p.reasons.some((r) => r.code === "processing-version-mismatch"))),
  "新老算法版本的结果并列保存，但不允许跨处理版本比较",
);

// ── 6. 正向用例：服药相位、提示版本、处理版本全部对齐时才给出可比差值 ──────

console.log("\n═══ 6. 可比路径自检（构造相位对齐的复诊） ═══");
const alignedReport = buildAlignedComparison(registry, summaryV1, run1.run, metricOf(run1.metrics, "v1-left-rest"));
const alignedRest = alignedReport.pairs.find((p) => p.task === "rest" && p.side === "left")!;
assert(alignedRest.comparable === true, "相位/提示/方案/处理版本一致时判定可比");
assert(
  alignedRest.deltaScore === Math.round((alignedRest.followup!.tremorScore - alignedRest.baseline!.tremorScore) * 100) / 100,
  "可比时 Δ 为两次同条件分数之差",
);

// ── 7. 审阅追溯：分数 → 试次 → 信号区间 → 处理版本 → 原始记录 ──────────────

console.log("\n═══ 7. 证据追溯链 ═══");
const followRestMetricId = metricOf(run1.metrics, "v2-left-rest").metricId;
const trace = registry.trace(followRestMetricId);
console.log(`  指标 ${trace.metric.metricId}`);
console.log(`    分数=${trace.metric.value.tremorScore} 峰值=${trace.metric.value.peakFrequencyHz}Hz 质量标记=${trace.metric.qualityFlags.join(",") || "无"}`);
console.log(`    ← 试次 ${trace.trial.trialId}（${trace.trial.task}/${trace.trial.side}，状态=${trace.trial.status}，服药相位=${trace.trial.medicationPhaseMinutes}分）`);
console.log(`    ← 信号区间 ${trace.metric.segmentWindows.map((w) => `${w.segmentId}[${w.windowMs[0]}-${w.windowMs[1]}ms]`).join(", ")}`);
console.log(`    ← blob ${trace.manifestEntry.segments[0]!.blobUri} sha256=${trace.manifestEntry.segments[0]!.blobSha256.slice(0, 20)}…`);
console.log(`    ← 处理运行 ${trace.run.runId}（${trace.run.algorithmVersion} / ${trace.run.parameterVersion}）`);
console.log(`    ← 输入清单 ${trace.manifest.manifestId}（${trace.manifest.normalizerVersion}，源 ${trace.manifest.sourceSha256.slice(0, 20)}…）`);
console.log(`    ← 复核 ${trace.reviews.map((r) => `${r.decision}`).join("、") || "无"}；被摘要 ${trace.referencedBy.map((s) => s.summaryId).join("、")}`);
const tracedSignalBytes = ingested.signalByTrial.get(trace.trial.trialId)!;
assert(sha256Bytes(tracedSignalBytes) === trace.metric.segmentWindows[0]!.blobSha256,
  "指标可逐层追溯到信号 blob 摘要（与清单一致）");
assert(trace.run.algorithmVersion === "tremor-algo-1.0.0" && trace.run.parameterVersion === "tremor-params-1",
  "追溯链包含算法与参数版本");

// ── 输出报告工件 ───────────────────────────────────────────────────────────

mkdirSync(new URL("../out", import.meta.url), { recursive: true });
writeFileSync(new URL("../out/comparison-v1-v2.json", import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(new URL("../out/signed-summary-v2.json", import.meta.url), `${JSON.stringify(signedV2, null, 2)}\n`);
writeFileSync(new URL("../out/input-manifest.json", import.meta.url), `${JSON.stringify(ingested.manifest, null, 2)}\n`);

console.log(`\n全部 ${checks} 项自检通过。报告已写入 out/（comparison-v1-v2.json、signed-summary-v2.json、input-manifest.json）`);

// ── 辅助：构造相位完全对齐的复诊摘要（仅用于证明可比路径） ──────────────────

function buildAlignedComparison(
  registry: AssessmentRegistry,
  baselineSummary: ClinicalSummary,
  run: MetricRun,
  baselineMetric: DerivedMetric,
): VisitComparisonReport {
  const alignedTrial: MotorTrial = {
    trialId: "vx-left-rest",
    visitId: "vx",
    protocolId: baselineMetric.protocolId,
    protocolVersion: baselineMetric.protocolVersion,
    task: "rest",
    side: "left",
    cueVersion: baselineMetric.cueVersion,
    medicationTakenAt: "2026-10-01T08:00:00+08:00",
    deviceClockStart: 600000,
    syncPulseAt: 599500,
    syncPulseClinicalAt: "2026-10-01T08:58:21.000+08:00",
    clinicalStartAt: "2026-10-01T08:58:20.500Z",
    medicationPhaseMinutes: baselineMetric.medicationPhaseMinutes, // 与基线相同相位
    status: "completed",
    deviations: [],
    scheduledDurationSeconds: 30,
    capturedDurationSeconds: 30,
    segments: [],
    recordedAt: "2026-10-01T00:58:21.000Z",
  };
  const alignedValue: TremorMetrics = {
    tremorScore: Math.round(baselineMetric.value.tremorScore * 0.8 * 100) / 100,
    peakFrequencyHz: 5.0,
    amplitudeG: 0.2,
    coverageRatio: 1,
  };
  const alignedMetric: DerivedMetric = {
    metricId: `metric_aligned_${baselineMetric.metricId}`,
    runId: run.runId,
    trialId: "vx-left-rest",
    visitId: "vx",
    task: "rest",
    side: "left",
    cueVersion: baselineMetric.cueVersion,
    protocolId: baselineMetric.protocolId,
    protocolVersion: baselineMetric.protocolVersion,
    medicationPhaseMinutes: baselineMetric.medicationPhaseMinutes,
    qualityFlags: [],
    value: alignedValue,
    segmentWindows: [],
  };
  registry.trials.append({ id: alignedTrial.trialId, ...alignedTrial });
  registry.metrics.append({ id: alignedMetric.metricId, ...alignedMetric });

  const alignedSummary = buildClinicalSummary({
    patientId: baselineSummary.patientId,
    authorId: "therapist-chen",
    createdAt: "2026-10-01T09:00:00+08:00",
    visitTrials: [alignedTrial],
    run,
    runMetrics: [alignedMetric],
    reviews: [],
  });
  registry.addSummary(alignedSummary);
  return compareVisits(registry, baselineSummary, alignedSummary, "2026-10-01T09:05:00+08:00");
}
