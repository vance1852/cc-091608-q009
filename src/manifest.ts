import { contentHashOf, freezeDeep } from "./canonical.js";
import type {
  InputManifest,
  InputManifestItem,
  MotorTrial,
  ProtocolVersion,
  SignalSegment,
} from "./contracts.js";

export interface ManifestInputs {
  trials: MotorTrial[];
  segments: SignalSegment[];
  protocol: ProtocolVersion;
  curationId: string | null;
  algorithmVersion: string;
  parameterVersion: string;
}

/**
 * 构建不可变输入清单：每个输入（试次、信号区间、方案、裁量集）
 * 以其内容哈希登记，清单哈希再覆盖算法与参数版本。
 * 返回的清单被深冻结；同一批输入无论顺序如何都得到同一 manifestHash。
 */
export function buildManifest(inputs: ManifestInputs): InputManifest {
  const items: InputManifestItem[] = [];

  const trials = [...inputs.trials].sort((a, b) =>
    a.trialId < b.trialId ? -1 : 1,
  );
  for (const trial of trials) {
    items.push({
      kind: "trial",
      id: trial.trialId,
      contentHash: contentHashOf(trial),
    });
  }

  const segments = [...inputs.segments].sort((a, b) =>
    a.segmentId < b.segmentId ? -1 : 1,
  );
  for (const segment of segments) {
    items.push({
      kind: "segment",
      id: segment.segmentId,
      contentHash: contentHashOf(segment),
    });
  }

  items.push({
    kind: "protocol",
    id: `${inputs.protocol.protocolId}@${inputs.protocol.version}`,
    contentHash: contentHashOf(inputs.protocol),
  });

  if (inputs.curationId !== null) {
    items.push({
      kind: "curation",
      id: inputs.curationId,
      contentHash: contentHashOf({ curationId: inputs.curationId }),
    });
  }

  const manifestHash = contentHashOf({
    algorithmVersion: inputs.algorithmVersion,
    parameterVersion: inputs.parameterVersion,
    items,
  });

  return freezeDeep({
    manifestHash,
    algorithmVersion: inputs.algorithmVersion,
    parameterVersion: inputs.parameterVersion,
    items,
  });
}

/**
 * 复核清单：重算每个输入的内容哈希并与清单逐项比对。
 * 任何原始记录在登记后被改动都会在这里暴露。
 */
export function verifyManifest(
  manifest: InputManifest,
  inputs: Pick<ManifestInputs, "trials" | "segments" | "protocol">,
): { ok: boolean; mismatches: string[] } {
  const expected = new Map(manifest.items.map((i) => [`${i.kind}:${i.id}`, i.contentHash]));
  const mismatches: string[] = [];

  const check = (kind: InputManifestItem["kind"], id: string, value: unknown) => {
    const key = `${kind}:${id}`;
    const want = expected.get(key);
    if (want === undefined) {
      mismatches.push(`${key} 不在清单中`);
      return;
    }
    const got = contentHashOf(value);
    if (got !== want) {
      mismatches.push(`${key} 内容哈希不一致（登记 ${want.slice(0, 12)}…，现算 ${got.slice(0, 12)}…）`);
    }
    expected.delete(key);
  };

  for (const trial of inputs.trials) check("trial", trial.trialId, trial);
  for (const segment of inputs.segments) check("segment", segment.segmentId, segment);
  check("protocol", `${inputs.protocol.protocolId}@${inputs.protocol.version}`, inputs.protocol);

  for (const leftover of expected.keys()) {
    if (!leftover.startsWith("curation:")) {
      mismatches.push(`清单项 ${leftover} 缺少对应输入`);
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}
