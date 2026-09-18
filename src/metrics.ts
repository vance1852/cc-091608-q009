import type { MetricName } from "./contracts.js";

export class UnknownVersionError extends Error {
  override readonly name = "UnknownVersionError";
}

interface AlgorithmParams {
  /** 截尾比例：去掉最高/最低各该比例的样本后再取均方，抑制瞬时伪差。 */
  trimFraction: number;
  unit: string;
}

/** 参数版本注册表：版本不可变，新参数只能以新版本号加入。 */
const PARAMETER_SETS: Record<string, AlgorithmParams> = {
  "params-2026.07": { trimFraction: 0, unit: "g^2/Hz" },
  "params-2026.09": { trimFraction: 0.25, unit: "g^2/Hz" },
};

type Algorithm = (samples: number[], params: AlgorithmParams) => number;

function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

function rms(samples: number[]): number {
  if (samples.length === 0) {
    throw new UnknownVersionError("无法对空样本集计算震颤分数");
  }
  const meanSquare =
    samples.reduce((acc, s) => acc + s * s, 0) / samples.length;
  return round6(Math.sqrt(meanSquare));
}

function trimmed(samples: number[], fraction: number): number[] {
  const sorted = [...samples].sort((a, b) => a - b);
  const k = Math.floor(sorted.length * fraction);
  return sorted.slice(k, sorted.length - k);
}

/** 算法注册表：同一版本号永远对应同一实现。 */
const ALGORITHMS: Record<string, Algorithm> = {
  "tremor-rms/1.0.0": (samples) => rms(samples),
  "tremor-rms/1.1.0": (samples, params) => rms(trimmed(samples, params.trimFraction)),
};

export function listAlgorithmVersions(): string[] {
  return Object.keys(ALGORITHMS);
}

export function listParameterVersions(): string[] {
  return Object.keys(PARAMETER_SETS);
}

export interface ComputedMetric {
  metric: MetricName;
  value: number;
  unit: string;
}

/**
 * 纯函数指标计算：输出只取决于 (algorithmVersion, parameterVersion, samples)。
 * 不含时钟、随机数或外部状态，因此同一输入清单可安全重算。
 */
export function computeTremorScore(
  algorithmVersion: string,
  parameterVersion: string,
  samples: number[],
): ComputedMetric {
  const algorithm = ALGORITHMS[algorithmVersion];
  if (!algorithm) {
    throw new UnknownVersionError(`未注册的算法版本: ${algorithmVersion}`);
  }
  const params = PARAMETER_SETS[parameterVersion];
  if (!params) {
    throw new UnknownVersionError(`未注册的参数版本: ${parameterVersion}`);
  }
  return {
    metric: "tremor-score",
    value: algorithm(samples, params),
    unit: params.unit,
  };
}
