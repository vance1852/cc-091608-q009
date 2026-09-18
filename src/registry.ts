import type {
  ClinicalSummary,
  DerivedMetric,
  InputManifest,
  MetricRun,
  MotorTrial,
  ProtocolVersion,
  SignedClinicalSummary,
  TrialReview,
} from "./contracts.js";
import type { RawTrialRecord } from "./ingest.js";
import { AppendOnlyStore } from "./store.js";

/** 一次处理链中全部不可变证据与结果的登记处（只追加）。 */
export class AssessmentRegistry {
  readonly protocols = new AppendOnlyStore<ProtocolVersion & { id: string }>();
  readonly trials = new AppendOnlyStore<MotorTrial & { id: string }>();
  readonly manifests = new AppendOnlyStore<InputManifest & { id: string }>();
  readonly runs = new AppendOnlyStore<MetricRun & { id: string }>();
  readonly metrics = new AppendOnlyStore<DerivedMetric & { id: string }>();
  readonly reviews = new AppendOnlyStore<TrialReview & { id: string }>();
  readonly summaries = new AppendOnlyStore<ClinicalSummary & { id: string }>();
  readonly signed = new AppendOnlyStore<SignedClinicalSummary & { id: string }>();

  readonly rawByTrial = new Map<string, RawTrialRecord>();

  addProtocols(list: ProtocolVersion[]): void {
    for (const p of list) this.protocols.append({ id: `${p.protocolId}@${p.version}`, ...p });
  }

  addTrials(list: MotorTrial[], raw: Map<string, RawTrialRecord>): void {
    for (const t of list) {
      this.trials.append({ id: t.trialId, ...t });
      const r = raw.get(t.trialId);
      if (r) this.rawByTrial.set(t.trialId, r);
    }
  }

  addManifest(manifest: InputManifest): void {
    this.manifests.append({ id: manifest.manifestId, ...manifest });
  }

  addRun(run: MetricRun, metrics: DerivedMetric[]): void {
    this.runs.append({ id: run.runId, ...run });
    for (const m of metrics) this.metrics.append({ id: m.metricId, ...m });
  }

  addReview(review: TrialReview): void {
    this.reviews.append({ id: review.reviewId, ...review });
  }

  addSummary(summary: ClinicalSummary): void {
    this.summaries.append({ id: summary.summaryId, ...summary });
  }

  addSigned(signed: SignedClinicalSummary): void {
    this.signed.append({ id: signed.summaryId, ...signed });
  }

  metricByTrial(trialId: string, runId?: string): DerivedMetric | undefined {
    return this.metrics
      .filter((m) => m.trialId === trialId && (runId === undefined || m.runId === runId))
      .at(-1);
  }

  protocol(protocolId: string, version: number): ProtocolVersion {
    return this.protocols.require(`${protocolId}@${version}`);
  }

  /** 分数 → 试次 → 信号区间 → 处理版本 的完整追溯链。 */
  trace(metricId: string): MetricTrace {
    const metric = this.metrics.require(metricId);
    const run = this.runs.require(metric.runId);
    const manifest = this.manifests.require(run.inputManifestId);
    const trial = this.trials.require(metric.trialId);
    const raw = this.rawByTrial.get(metric.trialId);
    const manifestEntry = manifest.entries.find((e) => e.trialId === metric.trialId);
    if (!manifestEntry) throw new Error(`manifest ${manifest.manifestId} has no entry for trial ${metric.trialId}`);
    const reviews = this.reviews.filter((r) => r.trialId === metric.trialId);
    const summaries = this.summaries
      .filter((s) => s.selections.some((sel) => sel.metricId === metricId))
      .map((s) => ({ summaryId: s.summaryId, visitId: s.visitId }));
    return { metric, run, manifest, manifestEntry, trial, raw, reviews, referencedBy: summaries };
  }
}

export interface MetricTrace {
  metric: DerivedMetric;
  run: MetricRun;
  manifest: InputManifest;
  manifestEntry: InputManifest["entries"][number];
  trial: MotorTrial;
  raw: RawTrialRecord | undefined;
  reviews: TrialReview[];
  referencedBy: Array<{ summaryId: string; visitId: string }>;
}
