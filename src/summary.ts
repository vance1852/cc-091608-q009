import { contentHashOf, freezeDeep } from "./canonical.js";
import type {
  ClinicalSummary,
  MetricOutput,
  SummaryEntry,
} from "./contracts.js";
import type { MetricRunRecord } from "./runs.js";

export class SummaryError extends Error {
  override readonly name = "SummaryError";
}

/** 摘要内容哈希只覆盖临床内容，不含签署元数据。 */
function summaryContent(summary: {
  visitId: string;
  protocolVersion: number;
  curationId: string | null;
  runId: string;
  entries: SummaryEntry[];
}): unknown {
  return {
    visitId: summary.visitId,
    protocolVersion: summary.protocolVersion,
    curationId: summary.curationId,
    runId: summary.runId,
    entries: summary.entries,
  };
}

/**
 * 由一次运行产出的指标构建新摘要（草稿）。
 * 治疗师每次调整裁量（排除片段、确认补做）后都会得到新的裁量集与
 * 新的运行，从而构建新的摘要版本，而不是改写旧摘要。
 */
export function buildSummary(args: {
  visitId: string;
  protocolVersion: number;
  curationId: string | null;
  run: MetricRunRecord;
  outputs: MetricOutput[];
  sequence: number;
  now: string;
  supersedes?: string | null;
}): ClinicalSummary {
  if (args.outputs.length === 0) {
    throw new SummaryError("没有可用的指标输出，无法形成摘要");
  }
  const entries: SummaryEntry[] = args.outputs
    .map((o) => ({
      task: o.task,
      side: o.side,
      protocolVersion: o.protocolVersion,
      metric: o.metric,
      value: o.value,
      unit: o.unit,
      runId: args.run.runId,
      trialId: o.trialId,
      segmentIds: [...o.segmentIds],
      medicationPhaseMinutes: o.medicationPhaseMinutes,
      algorithmVersion: args.run.algorithmVersion,
      parameterVersion: args.run.parameterVersion,
    }))
    .sort((a, b) =>
      a.task === b.task
        ? a.side < b.side
          ? -1
          : 1
        : a.task < b.task
          ? -1
          : 1,
    );

  const core = {
    visitId: args.visitId,
    protocolVersion: args.protocolVersion,
    curationId: args.curationId,
    runId: args.run.runId,
    entries,
  };
  return {
    summaryId: `sum-${args.visitId}-${args.sequence}`,
    ...core,
    status: "draft",
    contentHash: contentHashOf(summaryContent(core)),
    signedBy: null,
    signedAt: null,
    supersedes: args.supersedes ?? null,
    createdAt: args.now,
  };
}

/**
 * 签署摘要：返回冻结的新对象，原草稿不被改写。
 * 签署后 contentHash 固定；之后任何算法重算都只是产生新的运行，
 * 已签署摘要的内容与哈希保持不变。
 */
export function signSummary(
  summary: ClinicalSummary,
  signedBy: string,
  signedAt: string,
): ClinicalSummary {
  if (summary.status === "signed") {
    throw new SummaryError(`摘要 ${summary.summaryId} 已签署，不能重复签署`);
  }
  return freezeDeep({
    ...summary,
    entries: summary.entries.map((e) => ({ ...e, segmentIds: [...e.segmentIds] })),
    status: "signed",
    signedBy,
    signedAt,
  });
}

/** 校验摘要内容自签署以来未被改动。 */
export function verifySummary(summary: ClinicalSummary): boolean {
  return (
    contentHashOf(summaryContent(summary)) === summary.contentHash
  );
}
