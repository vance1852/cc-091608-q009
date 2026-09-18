import { compareVisits } from "./compare.js";
import { applyCuration, type CuratedView } from "./curation.js";
import type {
  ClinicalSummary,
  CurationSet,
  MotorTrial,
  ProtocolVersion,
  SignalSegment,
  VisitComparison,
} from "./contracts.js";
import { RunRegistry, type RunResult } from "./runs.js";
import { AssessmentStore, StoreError, type VisitRecord } from "./store.js";
import { buildSummary, signSummary } from "./summary.js";

/**
 * 应用服务层：把方案发布、访视采集、裁量、算法运行、摘要签署、
 * 访视比较串成一条不可变证据链。
 */
export class AssessmentService {
  readonly store: AssessmentStore;

  constructor() {
    this.store = new AssessmentStore(new RunRegistry());
  }

  publishProtocol(protocol: ProtocolVersion): void {
    this.store.publishProtocol(protocol);
  }

  ingestVisit(record: VisitRecord): void {
    this.store.ingestVisit(record);
  }

  registerCuration(set: CurationSet): void {
    // 确认裁量集指向已入库的访视
    this.store.visit(set.visitId);
    this.store.addCuration(set);
  }

  /** 应用裁量得到可用试次视图（不改动任何原始记录）。 */
  curate(visitId: string, curationId: string | null): CuratedView {
    const visit = this.store.visit(visitId);
    const curation = curationId === null ? null : this.store.curation(curationId);
    return applyCuration(
      visit.trials,
      visit.segmentsByTrial,
      visit.pulses,
      curation,
    );
  }

  /**
   * 重建一次运行当时消费的完整输入（裁量后的试次、信号区间与方案），
   * 供审阅者复核该运行的不可变输入清单。
   */
  inputsForRun(runId: string): {
    trials: MotorTrial[];
    segments: SignalSegment[];
    protocol: ProtocolVersion;
  } {
    const run = this.store.runs.get(runId);
    if (!run) throw new StoreError(`未知运行: ${runId}`);
    const visit = this.store.visit(run.visitId);
    const view = this.curate(run.visitId, run.curationId);
    return {
      trials: view.trials.map((c) => c.trial),
      segments: view.trials.flatMap((c) => c.segments),
      protocol: this.store.protocol(visit.protocolId, run.protocolVersion),
    };
  }

  /**
   * 执行一次算法运行。同一（算法, 参数, 裁量后输入）重复调用会安全复用
   * 原运行记录；任一要素变化都会追加一条新运行，与旧结果并列。
   */
  runAssessment(args: {
    visitId: string;
    curationId: string | null;
    algorithmVersion: string;
    parameterVersion: string;
    now: string;
  }): { result: RunResult; view: CuratedView } {
    const visit = this.store.visit(args.visitId);
    const view = this.curate(args.visitId, args.curationId);
    const protocol = this.store.protocol(visit.protocolId, visit.protocolVersion);
    const result = this.store.runs.execute({
      visitId: visit.visitId,
      protocol,
      curated: view.trials,
      curationId: args.curationId,
      algorithmVersion: args.algorithmVersion,
      parameterVersion: args.parameterVersion,
      now: args.now,
    });
    return { result, view };
  }

  /** 由一次运行的输出构建新的临床摘要草稿（不落库）。 */
  draftSummary(args: {
    visitId: string;
    curationId: string | null;
    runId: string;
    now: string;
    supersedes?: string | null;
  }): ClinicalSummary {
    const visit = this.store.visit(args.visitId);
    const run = this.store.runs.get(args.runId);
    if (!run) throw new StoreError(`未知运行: ${args.runId}`);
    const outputs = this.store.runs.outputsOf(args.runId);
    return buildSummary({
      visitId: args.visitId,
      protocolVersion: visit.protocolVersion,
      curationId: args.curationId,
      run,
      outputs,
      sequence: this.store.summariesOf(args.visitId).length + 1,
      now: args.now,
      supersedes: args.supersedes ?? null,
    });
  }

  /** 签署并入库。签署后的摘要不可再被替换。 */
  signAndStore(
    draft: ClinicalSummary,
    signedBy: string,
    signedAt: string,
  ): ClinicalSummary {
    const signed = signSummary(draft, signedBy, signedAt);
    this.store.addSummary(signed);
    return signed;
  }

  /** 比较两次访视的已签署摘要。 */
  compareSigned(args: {
    baselineSummaryId: string;
    followUpSummaryId: string;
    medicationPhaseToleranceMinutes?: number;
    now: string;
  }): VisitComparison {
    const baselineSummary = this.store.summary(args.baselineSummaryId);
    const followUpSummary = this.store.summary(args.followUpSummaryId);
    const baselineVisit = this.store.visit(baselineSummary.visitId);
    const followUpVisit = this.store.visit(followUpSummary.visitId);
    const compareArgs: Parameters<typeof compareVisits>[0] = {
      baseline: {
        visitId: baselineVisit.visitId,
        protocol: this.store.protocol(
          baselineVisit.protocolId,
          baselineSummary.protocolVersion,
        ),
        summary: baselineSummary,
      },
      followUp: {
        visitId: followUpVisit.visitId,
        protocol: this.store.protocol(
          followUpVisit.protocolId,
          followUpSummary.protocolVersion,
        ),
        summary: followUpSummary,
      },
      now: args.now,
    };
    if (args.medicationPhaseToleranceMinutes !== undefined) {
      compareArgs.medicationPhaseToleranceMinutes =
        args.medicationPhaseToleranceMinutes;
    }
    return compareVisits(compareArgs);
  }
}
