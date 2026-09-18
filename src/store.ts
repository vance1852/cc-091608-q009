import { contentHashOf } from "./canonical.js";
import type {
  ClinicalSummary,
  CurationSet,
  InputManifest,
  MetricOutput,
  MotorTask,
  MotorTrial,
  ProtocolVersion,
  SignalSegment,
  SummaryEntry,
  SyncPulse,
  WristSide,
} from "./contracts.js";
import type { MetricRunRecord, RunRegistry } from "./runs.js";

export class StoreError extends Error {
  override readonly name = "StoreError";
}

export interface VisitRecord {
  visitId: string;
  protocolId: string;
  protocolVersion: number;
  medicationTakenAt: string;
  pulses: SyncPulse[];
  trials: MotorTrial[];
  segmentsByTrial: Map<string, SignalSegment[]>;
}

/** 从分数回溯到原始证据与处理版本的完整链条。 */
export interface ScoreLineage {
  summaryId: string;
  entry: SummaryEntry;
  run: MetricRunRecord;
  manifest: InputManifest;
  trials: MotorTrial[];
  segments: SignalSegment[];
  curation: CurationSet | null;
  protocol: ProtocolVersion;
}

function protocolKey(protocolId: string, version: number): string {
  return `${protocolId}@${version}`;
}

/** 内存存储：方案、访视、裁量、摘要的仓储，以及算法运行登记处的挂载点。 */
export class AssessmentStore {
  readonly #protocols = new Map<string, ProtocolVersion>();
  readonly #protocolHashes = new Map<string, string>();
  readonly #visits = new Map<string, VisitRecord>();
  readonly #curations = new Map<string, CurationSet>();
  readonly #summaries = new Map<string, ClinicalSummary>();

  constructor(readonly runs: RunRegistry) {}

  /** 发布方案版本：同一 protocolId@version 不可被不同内容覆盖。 */
  publishProtocol(protocol: ProtocolVersion): void {
    const key = protocolKey(protocol.protocolId, protocol.version);
    const hash = contentHashOf(protocol);
    const existingHash = this.#protocolHashes.get(key);
    if (existingHash !== undefined) {
      if (existingHash !== hash) {
        throw new StoreError(
          `方案 ${key} 已发布，禁止以不同内容覆盖同一版本`,
        );
      }
      return;
    }
    if (protocol.tasks.length === 0) {
      throw new StoreError(`方案 ${key} 不包含任何任务段`);
    }
    this.#protocolHashes.set(key, hash);
    this.#protocols.set(key, Object.freeze(structuredClone(protocol)));
  }

  protocol(protocolId: string, version: number): ProtocolVersion {
    const p = this.#protocols.get(protocolKey(protocolId, version));
    if (!p) {
      throw new StoreError(`未发布的方案: ${protocolId}@${version}`);
    }
    return p;
  }

  ingestVisit(record: VisitRecord): void {
    if (this.#visits.has(record.visitId)) {
      throw new StoreError(`访视 ${record.visitId} 已入库，原始记录不可覆盖`);
    }
    // 确认访视引用的方案已发布
    this.protocol(record.protocolId, record.protocolVersion);
    this.#visits.set(record.visitId, record);
  }

  visit(visitId: string): VisitRecord {
    const v = this.#visits.get(visitId);
    if (!v) throw new StoreError(`未知访视: ${visitId}`);
    return v;
  }

  addCuration(set: CurationSet): void {
    if (this.#curations.has(set.curationId)) {
      throw new StoreError(`裁量集 ${set.curationId} 已存在`);
    }
    this.#curations.set(set.curationId, set);
  }

  curation(curationId: string): CurationSet {
    const c = this.#curations.get(curationId);
    if (!c) throw new StoreError(`未知裁量集: ${curationId}`);
    return c;
  }

  addSummary(summary: ClinicalSummary): void {
    if (this.#summaries.has(summary.summaryId)) {
      throw new StoreError(`摘要 ${summary.summaryId} 已存在`);
    }
    this.#summaries.set(summary.summaryId, summary);
  }

  summary(summaryId: string): ClinicalSummary {
    const s = this.#summaries.get(summaryId);
    if (!s) throw new StoreError(`未知摘要: ${summaryId}`);
    return s;
  }

  summariesOf(visitId: string): ClinicalSummary[] {
    return [...this.#summaries.values()].filter((s) => s.visitId === visitId);
  }

  outputsOf(runId: string): MetricOutput[] {
    return this.runs.outputsOf(runId);
  }

  /**
   * 审阅者追溯：从摘要中的一行分数出发，回到运行记录、不可变输入清单、
   * 原始试次与信号区间、裁量集、方案与算法/参数版本。
   */
  traceScore(
    summaryId: string,
    task: MotorTask,
    side: WristSide,
  ): ScoreLineage {
    const summary = this.summary(summaryId);
    const entry = summary.entries.find(
      (e) => e.task === task && e.side === side,
    );
    if (!entry) {
      throw new StoreError(`摘要 ${summaryId} 中没有 ${task}/${side} 条目`);
    }
    const run = this.runs.get(entry.runId);
    if (!run) {
      throw new StoreError(`摘要引用的运行 ${entry.runId} 不存在`);
    }
    const manifest = this.runs.manifestOf(entry.runId);
    if (!manifest) {
      throw new StoreError(`运行 ${entry.runId} 缺少输入清单`);
    }
    const visit = this.visit(summary.visitId);
    const trials = visit.trials.filter((t) => t.trialId === entry.trialId);
    const segments = entry.segmentIds.flatMap(
      (id) =>
        (visit.segmentsByTrial.get(entry.trialId) ?? []).filter(
          (s) => s.segmentId === id,
        ),
    );
    const curation =
      summary.curationId === null
        ? null
        : (this.#curations.get(summary.curationId) ?? null);
    const protocol = this.protocol(visit.protocolId, summary.protocolVersion);
    return {
      summaryId,
      entry,
      run,
      manifest,
      trials,
      segments,
      curation,
      protocol,
    };
  }
}
