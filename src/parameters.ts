import type { ParameterSet } from "./contracts.js";

export const SAMPLE_RATE_HZ = 100;

/**
 * 参数集按版本冻结。算法运行必须引用具体 parameterVersion，
 * 调整阈值会产生新的 run 与指标，旧结果不被覆盖。
 */
export const PARAMETER_SETS: Record<string, ParameterSet> = {
  "tremor-params-1": {
    parameterVersion: "tremor-params-1",
    phaseToleranceMinutes: 30,
    tremorBandHz: [3.5, 7.5],
    scoreScale: 100,
    minCoverageRatio: 0.9,
    sampleRateHz: SAMPLE_RATE_HZ,
    maxSyncAgeSeconds: 120,
  },
  "tremor-params-2": {
    parameterVersion: "tremor-params-2",
    phaseToleranceMinutes: 20,
    tremorBandHz: [4.0, 8.0],
    scoreScale: 100,
    minCoverageRatio: 0.9,
    sampleRateHz: SAMPLE_RATE_HZ,
    maxSyncAgeSeconds: 120,
  },
};

export function getParameterSet(version: string): ParameterSet {
  const params = PARAMETER_SETS[version];
  if (!params) throw new Error(`unknown parameter version: ${version}`);
  return params;
}
