import { sha256Hex } from "./canonical.js";
import type { CuratedTrial } from "./curation.js";
import { buildManifest } from "./manifest.js";
import { computeTremorScore } from "./metrics.js";
import type {
  InputManifest,
  MetricOutput,
  MetricRun,
  ProtocolVersion,
} from "./contracts.js";

export class RunConflictError extends Error {
  override readonly name = "RunConflictError";
}

/** 运行记录 = 契约 MetricRun + 绑定它的清单与上下文。 */
export interface MetricRunRecord extends MetricRun {
  visitId: string;
  protocolVersion: number;
  curationId: string | null;
  manifestHash: string;
}

export interface RunResult {
  run: MetricRunRecord;
  manifest: InputManifest;
  outputs: MetricOutput[];
  /** true 表示同一输入此前已算过，本次安全复用而未重复登记。 */
  reused: boolean;
}

/**
 * 只追加的算法运行登记处。
 * - runId 由 (算法版本, 参数版本, 输入清单) 派生：同一输入重算得到同一 runId，
 *   直接复用原记录，不产生重复运行；
 * - 新算法/新参数/新输入只会追加新记录，旧记录与旧结果永远并列保留。
 */
export class RunRegistry {
  readonly #runs = new Map<string, MetricRunRecord>();
  readonly #manifests = new Map<string, InputManifest>();
  readonly #outputs = new Map<string, MetricOutput[]>();

  execute(args: {
    visitId: string;
    protocol: ProtocolVersion;
    curated: CuratedTrial[];
    curationId: string | null;
    algorithmVersion: string;
    parameterVersion: string;
    now: string;
  }): RunResult {
    const trials = args.curated.map((c) => c.trial);
    const segments = args.curated.flatMap((c) => c.segments);
    const manifest = buildManifest({
      trials,
      segments,
      protocol: args.protocol,
      curationId: args.curationId,
      algorithmVersion: args.algorithmVersion,
      parameterVersion: args.parameterVersion,
    });
    const runId = `run-${sha256Hex(manifest.manifestHash).slice(0, 16)}`;

    const existing = this.#runs.get(runId);
    if (existing) {
      return {
        run: existing,
        manifest: this.#manifests.get(runId) ?? manifest,
        outputs: this.#outputs.get(runId) ?? [],
        reused: true,
      };
    }

    const outputs: MetricOutput[] = args.curated.map((c) => {
      const samples = c.segments.flatMap((s) => s.samples);
      const computed = computeTremorScore(
        args.algorithmVersion,
        args.parameterVersion,
        samples,
      );
      return {
        runId,
        trialId: c.trial.trialId,
        task: c.trial.task,
        side: c.trial.side,
        protocolVersion: args.protocol.version,
        metric: computed.metric,
        value: computed.value,
        unit: computed.unit,
        segmentIds: c.segments.map((s) => s.segmentId),
        medicationPhaseMinutes: c.medicationPhaseMinutes,
      };
    });

    const run: MetricRunRecord = Object.freeze({
      runId,
      algorithmVersion: args.algorithmVersion,
      parameterVersion: args.parameterVersion,
      inputTrialIds: trials.map((t) => t.trialId),
      createdAt: args.now,
      visitId: args.visitId,
      protocolVersion: args.protocol.version,
      curationId: args.curationId,
      manifestHash: manifest.manifestHash,
    });

    this.#runs.set(runId, run);
    this.#manifests.set(runId, manifest);
    this.#outputs.set(runId, Object.freeze([...outputs]) as MetricOutput[]);
    return { run, manifest, outputs, reused: false };
  }

  get(runId: string): MetricRunRecord | undefined {
    return this.#runs.get(runId);
  }

  manifestOf(runId: string): InputManifest | undefined {
    return this.#manifests.get(runId);
  }

  outputsOf(runId: string): MetricOutput[] {
    return this.#outputs.get(runId) ?? [];
  }

  /** 所有运行按登记顺序并列返回，新旧结果互不覆盖。 */
  list(): MetricRunRecord[] {
    return [...this.#runs.values()];
  }

  get size(): number {
    return this.#runs.size;
  }
}
