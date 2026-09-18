import type {
  ClinicalSummary,
  ComparisonIssue,
  ComparisonRow,
  MotorTask,
  ProtocolVersion,
  SummaryEntry,
  VisitComparison,
  WristSide,
} from "./contracts.js";

export class AggregationError extends Error {
  override readonly name = "AggregationError";
}

const SIDES: WristSide[] = ["left", "right"];

export interface VisitSide {
  visitId: string;
  protocol: ProtocolVersion;
  summary: ClinicalSummary;
}

function taskSpec(protocol: ProtocolVersion, task: MotorTask) {
  return protocol.tasks.find((t) => t.kind === task);
}

function entryFor(
  summary: ClinicalSummary,
  task: MotorTask,
  side: WristSide,
): SummaryEntry | null {
  return (
    summary.entries.find((e) => e.task === task && e.side === side) ?? null
  );
}

function round4(x: number): number {
  return Math.round(x * 10_000) / 10_000;
}

/**
 * 比较两次访视。逐 任务 × 侧 对齐：
 * - 两侧腕部分开成行，绝不合并；
 * - 任务定义（时长、提示节拍版本）不一致 → protocol-spec-mismatch；
 * - 服药相位差超过容差 → medication-phase-mismatch；
 * - 任一访视缺少可用试次 → no-usable-trial / task-not-in-protocol。
 * 只有全部检查通过的行才给出 delta。
 */
export function compareVisits(args: {
  baseline: VisitSide;
  followUp: VisitSide;
  medicationPhaseToleranceMinutes?: number;
  now: string;
}): VisitComparison {
  const tolerance = args.medicationPhaseToleranceMinutes ?? 30;
  const { baseline, followUp } = args;

  const taskKinds = new Set<MotorTask>();
  for (const t of baseline.protocol.tasks) taskKinds.add(t.kind);
  for (const t of followUp.protocol.tasks) taskKinds.add(t.kind);

  const rows: ComparisonRow[] = [];

  for (const task of taskKinds) {
    const baseSpec = taskSpec(baseline.protocol, task);
    const fuSpec = taskSpec(followUp.protocol, task);

    for (const side of SIDES) {
      const issues: ComparisonIssue[] = [];

      if (!baseSpec) {
        issues.push({
          code: "task-not-in-protocol",
          detail: `任务 ${task} 不在基线方案 ${baseline.protocol.protocolId}@${baseline.protocol.version} 中`,
        });
      }
      if (!fuSpec) {
        issues.push({
          code: "task-not-in-protocol",
          detail: `任务 ${task} 不在随访方案 ${followUp.protocol.protocolId}@${followUp.protocol.version} 中`,
        });
      }

      if (baseSpec && fuSpec) {
        const diffs: string[] = [];
        if (baseSpec.cueVersion !== fuSpec.cueVersion) {
          diffs.push(
            `提示节拍版本不同（${baseSpec.cueVersion} vs ${fuSpec.cueVersion}）`,
          );
        }
        if (baseSpec.durationSeconds !== fuSpec.durationSeconds) {
          diffs.push(
            `时长不同（${baseSpec.durationSeconds}s vs ${fuSpec.durationSeconds}s）`,
          );
        }
        if (diffs.length > 0) {
          issues.push({
            code: "protocol-spec-mismatch",
            detail: `方案 ${baseline.protocol.protocolId}@${baseline.protocol.version} 与 @${followUp.protocol.version} 的 ${task} 段不一致：${diffs.join("；")}`,
          });
        }
      }

      const baseEntry = entryFor(baseline.summary, task, side);
      const fuEntry = entryFor(followUp.summary, task, side);
      if (!baseEntry) {
        issues.push({
          code: "no-usable-trial",
          detail: `基线访视 ${baseline.visitId} 缺少可用的 ${task}/${side} 试次`,
        });
      }
      if (!fuEntry) {
        issues.push({
          code: "no-usable-trial",
          detail: `随访访视 ${followUp.visitId} 缺少可用的 ${task}/${side} 试次`,
        });
      }

      if (baseEntry && fuEntry) {
        const phaseDiff = Math.abs(
          fuEntry.medicationPhaseMinutes - baseEntry.medicationPhaseMinutes,
        );
        if (phaseDiff > tolerance) {
          issues.push({
            code: "medication-phase-mismatch",
            detail:
              `服药相位相差 ${round4(phaseDiff)} 分钟（基线 ${baseEntry.medicationPhaseMinutes}，` +
              `随访 ${fuEntry.medicationPhaseMinutes}，容差 ±${tolerance}）`,
          });
        }
      }

      const comparable = issues.length === 0;
      rows.push({
        task,
        side,
        baseline: baseEntry,
        followUp: fuEntry,
        delta:
          comparable && baseEntry && fuEntry
            ? round4(fuEntry.value - baseEntry.value)
            : null,
        comparable,
        issues,
      });
    }
  }

  return {
    baselineVisitId: baseline.visitId,
    followUpVisitId: followUp.visitId,
    medicationPhaseToleranceMinutes: tolerance,
    generatedAt: args.now,
    rows,
  };
}

/**
 * 聚合守卫：任何跨试次的汇总只允许在 同一任务 × 同一侧 × 同一方案版本 的
 * 条目集合上进行。左右腕、不同方案的指标禁止直接拼接。
 */
export function assertAggregatable(entries: SummaryEntry[]): void {
  const sides = new Set(entries.map((e) => e.side));
  if (sides.size > 1) {
    throw new AggregationError(
      `禁止跨腕侧聚合（涉及 ${[...sides].join("/")}）：左右腕指标必须分别报告`,
    );
  }
  const tasks = new Set(entries.map((e) => e.task));
  if (tasks.size > 1) {
    throw new AggregationError(
      `禁止跨任务聚合（涉及 ${[...tasks].join("/")}）`,
    );
  }
  const protocols = new Set(entries.map((e) => e.protocolVersion));
  if (protocols.size > 1) {
    throw new AggregationError(
      `禁止跨方案版本聚合（涉及 v${[...protocols].join("/v")}）`,
    );
  }
}

/** 同侧同任务条目的均值汇总；先经过聚合守卫。 */
export function aggregateSameScope(entries: SummaryEntry[]): number {
  assertAggregatable(entries);
  if (entries.length === 0) {
    throw new AggregationError("没有可聚合的条目");
  }
  const sum = entries.reduce((acc, e) => acc + e.value, 0);
  return round4(sum / entries.length);
}
