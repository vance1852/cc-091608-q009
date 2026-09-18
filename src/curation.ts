import { medicationPhaseMinutes } from "./clock-sync.js";
import type {
  CurationDecision,
  CurationSet,
  MotorTrial,
  SignalSegment,
  SyncPulse,
} from "./contracts.js";

export class CurationError extends Error {
  override readonly name = "CurationError";
}

/** 裁量后可用于算法运行的试次视图。 */
export interface CuratedTrial {
  trial: MotorTrial;
  segments: SignalSegment[];
  medicationPhaseMinutes: number;
}

export interface DroppedTrial {
  trialId: string;
  reason: string;
}

export interface CuratedView {
  trials: CuratedTrial[];
  dropped: DroppedTrial[];
}

export function createCurationSet(args: {
  visitId: string;
  version: number;
  decisions: CurationDecision[];
  createdAt: string;
  supersedes?: string | null;
}): CurationSet {
  if (args.decisions.length === 0) {
    throw new CurationError("裁量集至少包含一条决定");
  }
  const curationId = `cur-${args.visitId}-v${args.version}`;
  return {
    curationId,
    visitId: args.visitId,
    version: args.version,
    decisions: args.decisions,
    supersedes: args.supersedes ?? null,
    createdAt: args.createdAt,
  };
}

/**
 * 把裁量集应用到一次访视的原始记录上：
 * - exclude-segment：该信号区间从输入中移除（原始记录保留，仅不再参与计算）；
 * - exclude-trial：整个试次移除；
 * - interrupted 试次默认不可用；
 * - make-up 试次只有在 confirm-make-up 决定之后才可用。
 * 本函数不修改任何传入记录，只返回新的视图。
 */
export function applyCuration(
  trials: MotorTrial[],
  segmentsByTrial: ReadonlyMap<string, SignalSegment[]>,
  pulses: SyncPulse[],
  curation: CurationSet | null,
): CuratedView {
  const excludedSegments = new Set<string>();
  const excludedTrials = new Set<string>();
  const confirmedMakeUps = new Set<string>();

  for (const decision of curation?.decisions ?? []) {
    switch (decision.kind) {
      case "exclude-segment":
        excludedSegments.add(decision.targetId);
        break;
      case "exclude-trial":
        excludedTrials.add(decision.targetId);
        break;
      case "confirm-make-up":
        confirmedMakeUps.add(decision.targetId);
        break;
    }
  }

  const usable: CuratedTrial[] = [];
  const dropped: DroppedTrial[] = [];

  for (const trial of trials) {
    const drop = (reason: string) => dropped.push({ trialId: trial.trialId, reason });

    if (excludedTrials.has(trial.trialId)) {
      drop("治疗师已排除该试次");
      continue;
    }
    if (trial.status === "interrupted") {
      drop("试次中断，默认不可用");
      continue;
    }
    if (trial.status === "make-up" && !confirmedMakeUps.has(trial.trialId)) {
      drop("补做试次未经治疗师确认");
      continue;
    }

    const segments = (segmentsByTrial.get(trial.trialId) ?? []).filter(
      (s) => !excludedSegments.has(s.segmentId),
    );
    if (segments.length === 0) {
      drop("排除后无可用信号区间");
      continue;
    }
    usable.push({
      trial,
      segments,
      medicationPhaseMinutes: medicationPhaseMinutes(trial, pulses),
    });
  }

  return { trials: usable, dropped };
}
