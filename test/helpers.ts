import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AssessmentService,
  parseFixture,
  type FixtureData,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
// 编译后位于 dist/test/，需上溯两级回到仓库根目录
const FIXTURE_PATH = join(here, "..", "..", "fixtures", "motor-assessments.json");

export function loadFixture(): FixtureData {
  return parseFixture(JSON.parse(readFileSync(FIXTURE_PATH, "utf8")));
}

export const ALGO_V1 = "tremor-rms/1.0.0";
export const PARAMS_V1 = "params-2026.07";
export const NOW = "2026-09-18T09:00:00+08:00";

/** 发布方案并入库两次访视的就绪服务。 */
export function serviceWithFixture(): AssessmentService {
  const service = new AssessmentService();
  const fixture = loadFixture();
  for (const protocol of fixture.protocols) service.publishProtocol(protocol);
  for (const visit of fixture.visits) service.ingestVisit(visit);
  return service;
}
