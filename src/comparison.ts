import { contentId } from "./canonical.js";
import type {
  ClinicalSummary,
  ComparedMetricRef,
  DerivedMetric,
  IncomparableReason,
  MetricRun,
  ProtocolVersion,
  TrialComparison,
  VisitComparisonReport,
} from "./contracts.js";
import type { AssessmentRegistry } from "./registry.js";
import { taskOrder } from "./clinical.js";
import { getParameterSet } from "./parameters.js";

/**
 * 比较两次就诊的已签署/已定稿临床摘要。
 *
 * 对齐维度（全部满足才可比）：
 *  1. 同一动作、同一佩戴侧（左右腕绝不互相拼接）；
 *  2. 两侧均有有效试次（中断未补做、缺失 → 不可比）；
 *  3. 动作提示（节拍）版本一致；
 *  4. 方案对该任务的规格（时长）一致；
 *  5. 服药相位差 ≤ 参数版本允许的窗口；
 *  6. 派生指标来自同一算法+参数版本（新老结果并列，但不跨版本比较）。
 * 不可比时仍展示 rawDeltaScore，但必须附带原因，且 deltaScore 为 null（不得作为疗效证据）。
 */
export function compareVisits(
  registry: AssessmentRegistry,
  baseline: ClinicalSummary,
  followup: ClinicalSummary,
  generatedAt: string,
): VisitComparisonReport {
  if (baseline.patientId !== followup.patientId) {
    throw new Error("cannot compare summaries of different patients");
  }

  const params = getParameterSet(baseline.parameterVersion);
  const tolerance = params.phaseToleranceMinutes;

  const keys = new Set<string>();
  const selMap = (s: ClinicalSummary): Map<string, ClinicalSummary["selections"][number]> => {
    const m = new Map<string, ClinicalSummary["selections"][number]>();
    for (const sel of s.selections) {
      const key = `${sel.task}|${sel.side}`;
      keys.add(key);
      m.set(key, sel);
    }
    return m;
  };
  const baseSel = selMap(baseline);
  const followSel = selMap(followup);

  const pairs: TrialComparison[] = [];
  for (const key of [...keys].sort(compareKeys)) {
    const [task, side] = key.split("|") as [TrialComparison["task"], TrialComparison["side"]];
    const bSel = baseSel.get(key);
    const fSel = followSel.get(key);
    const reasons: IncomparableReason[] = [];
    const advisories: string[] = [];

    if (!bSel) {
      reasons.push(reason("no-valid-trial-baseline", "基线访视在该任务/佩戴侧无有效试次", { task, side }));
    }
    if (!fSel) {
      reasons.push(reason("no-valid-trial-followup", "复诊在该任务/佩戴侧无有效试次（缺失或被排除/未确认补做）", { task, side }));
    }

    let bRef: ComparedMetricRef | null = null;
    let fRef: ComparedMetricRef | null = null;
    if (bSel) bRef = toRef(registry, baseline.visitId, bSel);
    if (fSel) fRef = toRef(registry, followup.visitId, fSel);

    if (bRef && fRef) {
      // 结构性保证：配对来自同一次 Map 键，侧别必然一致；仍显式校验防止绕过。
      if (bRef.side !== side || fRef.side !== side || bRef.side !== fRef.side) {
        reasons.push(reason("side-mismatch", "佩戴侧不一致，禁止左右腕拼接", {
          baselineSide: bRef.side, followupSide: fRef.side,
        }));
      }

      if (bRef.cueVersion !== fRef.cueVersion) {
        reasons.push(reason("cue-version-mismatch", "动作提示/节拍版本不同，提示条件改变", {
          baselineCue: bRef.cueVersion, followupCue: fRef.cueVersion,
        }));
      }

      const bProto = registry.protocol(baseline.protocolId, baseline.protocolVersion);
      const fProto = registry.protocol(followup.protocolId, followup.protocolVersion);
      const bSpec = specOf(bProto, task);
      const fSpec = specOf(fProto, task);
      if (bSpec.durationSeconds !== fSpec.durationSeconds) {
        reasons.push(reason("protocol-spec-mismatch", "方案规定时长不同", {
          baselineSeconds: bSpec.durationSeconds, followupSeconds: fSpec.durationSeconds,
        }));
      }

      const phaseShift = Math.round(Math.abs(fRef.medicationPhaseMinutes - bRef.medicationPhaseMinutes) * 100) / 100;
      if (phaseShift > tolerance) {
        reasons.push(reason("medication-phase-shift", `服药相位相差 ${phaseShift} 分钟，超过 ±${tolerance} 分钟窗口`, {
          baselinePhaseMinutes: bRef.medicationPhaseMinutes,
          followupPhaseMinutes: fRef.medicationPhaseMinutes,
          shiftMinutes: phaseShift,
          toleranceMinutes: tolerance,
        }));
      }

      if (
        baseline.algorithmVersion !== followup.algorithmVersion ||
        baseline.parameterVersion !== followup.parameterVersion
      ) {
        reasons.push(reason("processing-version-mismatch", "两次指标来自不同的算法/参数版本，不能跨版本比较", {
          baselineAlgorithm: baseline.algorithmVersion,
          followupAlgorithm: followup.algorithmVersion,
          baselineParams: baseline.parameterVersion,
          followupParams: followup.parameterVersion,
        }));
      }

      if (bSel!.basis === "confirmed-make-up" || fSel!.basis === "confirmed-make-up") {
        advisories.push("含经治疗师确认的补做试次，已按确认结果采用");
      }
      const bTrial = registry.trials.require(bRef.trialId);
      const fTrial = registry.trials.require(fRef.trialId);
      for (const d of [...bTrial.deviations, ...fTrial.deviations]) {
        advisories.push(`执行偏差留痕：${d}`);
      }
    }

    const rawDeltaScore = bRef && fRef ? round2(fRef.tremorScore - bRef.tremorScore) : null;
    const comparable = reasons.length === 0 && bRef !== null && fRef !== null;

    pairs.push({
      task,
      side,
      comparable,
      baseline: bRef,
      followup: fRef,
      rawDeltaScore,
      deltaScore: comparable ? rawDeltaScore : null,
      reasons,
      advisories: [...new Set(advisories)],
    });
  }

  const generatedFromRunIds = [...new Set([
    ...baseline.selections.map((s) => s.runId),
    ...followup.selections.map((s) => s.runId),
  ])].sort();

  const body = {
    patientId: baseline.patientId,
    baselineVisitId: baseline.visitId,
    followupVisitId: followup.visitId,
    algorithmVersion: `${baseline.algorithmVersion}|${followup.algorithmVersion}`,
    parameterVersion: `${baseline.parameterVersion}|${followup.parameterVersion}`,
    phaseToleranceMinutes: tolerance,
    generatedFromRunIds,
    pairs,
  };
  return { reportId: contentId("report", body), ...body, generatedAt };
}

function toRef(
  registry: AssessmentRegistry,
  visitId: string,
  sel: ClinicalSummary["selections"][number],
): ComparedMetricRef {
  const metric: DerivedMetric = registry.metrics.require(sel.metricId);
  const run: MetricRun = registry.runs.require(sel.runId);
  return {
    visitId,
    trialId: sel.chosenTrialId,
    metricId: sel.metricId,
    runId: sel.runId,
    basis: sel.basis,
    task: sel.task,
    side: sel.side,
    tremorScore: metric.value.tremorScore,
    medicationPhaseMinutes: metric.medicationPhaseMinutes,
    cueVersion: metric.cueVersion,
    protocolVersion: metric.protocolVersion,
    // run 与指标必须属于同一处理运行。
    ...(metric.runId !== run.runId ? (() => { throw new Error(`metric ${metric.metricId} does not belong to run ${sel.runId}`); })() : {}),
  };
}

function specOf(proto: ProtocolVersion, task: TrialComparison["task"]) {
  const spec = proto.tasks.find((t) => t.kind === task);
  if (!spec) throw new Error(`protocol ${proto.protocolId}@${proto.version} has no task ${task}`);
  return spec;
}

function reason(
  code: IncomparableReason["code"],
  message: string,
  details?: Record<string, string | number | boolean>,
): IncomparableReason {
  return { code, message, ...(details ? { details } : {}) };
}

function compareKeys(a: string, b: string): number {
  const [at, as] = a.split("|");
  const [bt, bs] = b.split("|");
  const ta = taskOrder(at!);
  const tb = taskOrder(bt!);
  return ta - tb || (as! < bs! ? -1 : 1);
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
