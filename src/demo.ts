import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseFixture } from "./ingest.js";
import { AssessmentService } from "./service.js";
import { createCurationSet } from "./curation.js";
import { verifySummary } from "./summary.js";
import { verifyManifest } from "./manifest.js";
import type { VisitComparison } from "./contracts.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "..", "..", "fixtures", "motor-assessments.json");
const fixture = parseFixture(JSON.parse(readFileSync(fixturePath, "utf8")));

const service = new AssessmentService();
const line = (s = "") => console.log(s);

// ── 1. 治疗师发布方案版本 ─────────────────────────────────────────
for (const protocol of fixture.protocols) {
  service.publishProtocol(protocol);
  line(
    `已发布方案 ${protocol.protocolId}@${protocol.version}：` +
      protocol.tasks
        .map((t) => `${t.kind}(${t.durationSeconds}s, ${t.cueVersion})`)
        .join("、"),
  );
}
line();

// ── 2. 采集端两次访视入库 ─────────────────────────────────────────
for (const visit of fixture.visits) {
  service.ingestVisit(visit);
  line(
    `访视 ${visit.visitId} 入库：方案 v${visit.protocolVersion}，` +
      `服药 ${visit.medicationTakenAt}，${visit.trials.length} 个试次`,
  );
}
line();

// ── 3. 随访访视 v2 先做一版未裁量的运行（含伪差片段） ─────────────
const ALGO_V1 = "tremor-rms/1.0.0";
const PARAMS_V1 = "params-2026.07";

const rough = service.runAssessment({
  visitId: "v2",
  curationId: null,
  algorithmVersion: ALGO_V1,
  parameterVersion: PARAMS_V1,
  now: "2026-09-01T11:00:00+08:00",
});
const roughRest = rough.result.outputs.find(
  (o) => o.trialId === "v2-left-rest",
);
line(
  `未裁量运行 ${rough.result.run.runId}：v2 左腕静息分数 ${roughRest?.value} ` +
    `（混入运动伪差片段 v2-left-rest-seg2，不可用）`,
);
line(`  被默认排除的试次：${rough.view.dropped.map((d) => `${d.trialId}（${d.reason}）`).join("；")}`);
line();

// ── 4. 治疗师裁量：排除伪差片段、确认补做 ─────────────────────────
const curation = createCurationSet({
  visitId: "v2",
  version: 1,
  createdAt: "2026-09-01T11:30:00+08:00",
  decisions: [
    {
      decisionId: "d1",
      kind: "exclude-segment",
      targetId: "v2-left-rest-seg2",
      reason: "运动伪差（motion-artifact），非震颤信号",
      decidedBy: "therapist-wang",
      decidedAt: "2026-09-01T11:20:00+08:00",
    },
    {
      decisionId: "d2",
      kind: "confirm-make-up",
      targetId: "v2-walk-b",
      reason: "补做完整，替代中断的 v2-walk-a",
      decidedBy: "therapist-wang",
      decidedAt: "2026-09-01T11:25:00+08:00",
    },
  ],
});
service.registerCuration(curation);
line(`登记裁量集 ${curation.curationId}：排除 1 个伪差片段，确认 1 次补做`);
line();

// ── 5. 裁量后重算（同一算法，输入清单已变 → 新运行与旧运行并列） ──
const curated = service.runAssessment({
  visitId: "v2",
  curationId: curation.curationId,
  algorithmVersion: ALGO_V1,
  parameterVersion: PARAMS_V1,
  now: "2026-09-01T11:35:00+08:00",
});
const curatedRest = curated.result.outputs.find(
  (o) => o.trialId === "v2-left-rest",
);
line(
  `裁量后运行 ${curated.result.run.runId}：v2 左腕静息分数 ${curatedRest?.value} ` +
    `（仅取片段 ${curatedRest?.segmentIds.join("、")}）`,
);
line(`  运行登记处现有 ${service.store.runs.size} 次运行，新旧并列`);
line();

// ── 6. 基线访视 v1 运行 + 两次访视各自形成并签署临床摘要 ──────────
const baseline = service.runAssessment({
  visitId: "v1",
  curationId: null,
  algorithmVersion: ALGO_V1,
  parameterVersion: PARAMS_V1,
  now: "2026-08-01T10:00:00+08:00",
});

const summaryV1 = service.signAndStore(
  service.draftSummary({
    visitId: "v1",
    curationId: null,
    runId: baseline.result.run.runId,
    now: "2026-08-01T10:05:00+08:00",
  }),
  "dr-chen",
  "2026-08-01T10:10:00+08:00",
);
const summaryV2 = service.signAndStore(
  service.draftSummary({
    visitId: "v2",
    curationId: curation.curationId,
    runId: curated.result.run.runId,
    now: "2026-09-01T11:40:00+08:00",
  }),
  "dr-chen",
  "2026-09-01T11:45:00+08:00",
);
line(`已签署摘要 ${summaryV1.summaryId}（hash ${summaryV1.contentHash.slice(0, 12)}…）`);
line(`已签署摘要 ${summaryV2.summaryId}（hash ${summaryV2.contentHash.slice(0, 12)}…）`);
line();

// ── 7. 比较两次访视：对齐服药相位与可比试次 ───────────────────────
const comparison: VisitComparison = service.compareSigned({
  baselineSummaryId: summaryV1.summaryId,
  followUpSummaryId: summaryV2.summaryId,
  now: "2026-09-01T12:00:00+08:00",
});
line(`访视比较 ${comparison.baselineVisitId} → ${comparison.followUpVisitId}（相位容差 ±${comparison.medicationPhaseToleranceMinutes} 分钟）：`);
for (const row of comparison.rows) {
  const b = row.baseline ? row.baseline.value.toFixed(4) : "—";
  const f = row.followUp ? row.followUp.value.toFixed(4) : "—";
  const d = row.delta === null ? "—" : row.delta.toFixed(4);
  line(`  ${row.task}/${row.side}: 基线 ${b} → 随访 ${f}  Δ ${d}`);
  for (const issue of row.issues) {
    line(`    ⚠ [${issue.code}] ${issue.detail}`);
  }
}
line();
const restLeft = comparison.rows.find(
  (r) => r.task === "rest" && r.side === "left",
);
line(
  `结论：左腕静息震颤分数 ${restLeft?.baseline?.value} → ${restLeft?.followUp?.value} ` +
    `看似下降，但因上述协议偏差被标记为不可比较，不能据此调药。`,
);
line();

// ── 8. 新算法版本重算：与旧结果并列，已签署摘要不变 ───────────────
const rerun = service.runAssessment({
  visitId: "v2",
  curationId: curation.curationId,
  algorithmVersion: "tremor-rms/1.1.0",
  parameterVersion: "params-2026.09",
  now: "2026-09-10T09:00:00+08:00",
});
const rerunRest = rerun.result.outputs.find((o) => o.trialId === "v2-left-rest");
line(
  `新算法 tremor-rms/1.1.0 重算：运行 ${rerun.result.run.runId}，` +
    `v2 左腕静息 ${rerunRest?.value}（旧运行 ${curated.result.run.runId} 的 ${curatedRest?.value} 仍并列保留）`,
);
line(
  `已签署摘要 ${summaryV2.summaryId} 校验：${verifySummary(summaryV2) ? "内容未随重算变化 ✓" : "内容被改动 ✗"}`,
);
line();

// ── 9. 审阅者追溯：从分数回到原始证据 ─────────────────────────────
const lineage = service.store.traceScore(summaryV2.summaryId, "rest", "left");
line(`追溯 ${summaryV2.summaryId} 的 rest/left 分数 ${lineage.entry.value}：`);
line(`  运行 ${lineage.run.runId}（算法 ${lineage.run.algorithmVersion}，参数 ${lineage.run.parameterVersion}）`);
line(`  输入清单 ${lineage.manifest.manifestHash.slice(0, 16)}…（${lineage.manifest.items.length} 项）`);
for (const trial of lineage.trials) {
  line(
    `  试次 ${trial.trialId}：${trial.side} 腕，设备 ${trial.deviceId}，` +
      `服药相位 ${lineage.entry.medicationPhaseMinutes} 分钟`,
  );
}
for (const seg of lineage.segments) {
  line(
    `  信号区间 ${seg.segmentId}：设备时钟 ${seg.deviceClockStart}–${seg.deviceClockEnd}，${seg.samples.length} 个样本`,
  );
}
line(`  裁量集 ${lineage.curation?.curationId ?? "（无）"}，方案 ${lineage.protocol.protocolId}@${lineage.protocol.version}`);

// 复核整个运行的输入清单：重建该运行当时消费的完整输入，逐项比对内容哈希
const runInputs = service.inputsForRun(lineage.run.runId);
const check = verifyManifest(lineage.manifest, runInputs);
line(`  清单复核（覆盖该运行全部 ${runInputs.trials.length} 个试次、${runInputs.segments.length} 个信号区间）：${check.ok ? "原始记录与登记时一致 ✓" : `不一致 ✗ ${check.mismatches.join("；")}`}`);
