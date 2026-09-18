import { generateKeyPairSync, verify as verifySig, sign as signBytes, type KeyObject } from "node:crypto";
import { canonicalJson, contentId, sha256Hex } from "./canonical.js";
import type {
  ClinicalSummary,
  DerivedMetric,
  MetricRun,
  MotorTrial,
  SignedClinicalSummary,
  SummaryExclusion,
  SummarySelection,
  TrialReview,
} from "./contracts.js";

// ── 治疗师复核（排除片段 / 确认补做） ──────────────────────────────────────

export function createReview(input: {
  trialId: string;
  decision: TrialReview["decision"];
  reason: string;
  reviewerId: string;
  decidedAt: string;
}): TrialReview {
  const body = {
    trialId: input.trialId,
    decision: input.decision,
    reason: input.reason,
    reviewerId: input.reviewerId,
    decidedAt: input.decidedAt,
  };
  return { reviewId: contentId("review", body), ...body };
}

// ── 临床摘要：把协议偏差（排除/中断）与真实采用的试次分开 ──────────────────

export interface SummaryInput {
  patientId: string;
  authorId: string;
  createdAt: string;
  note?: string;
  visitTrials: MotorTrial[];
  run: MetricRun;
  runMetrics: DerivedMetric[];
  reviews: TrialReview[];
}

export function buildClinicalSummary(input: SummaryInput): ClinicalSummary {
  const visitId = mustBeSingle(input.visitTrials.map((t) => t.visitId), "visitId");
  const protocolId = mustBeSingle(input.visitTrials.map((t) => t.protocolId), "protocolId");
  const protocolVersion = mustBeSingle(input.visitTrials.map((t) => t.protocolVersion), "protocolVersion");

  const reviewByTrial = new Map(input.reviews.map((r) => [r.trialId, r]));
  const metricByTrial = new Map(input.runMetrics.map((m) => [m.trialId, m]));

  interface Candidate {
    trial: MotorTrial;
    metric: DerivedMetric;
    eligible: boolean;
    basis: SummarySelection["basis"] | null;
    excludeReason: string | null;
  }

  const candidates: Candidate[] = input.visitTrials.map((trial) => {
    const metric = metricByTrial.get(trial.trialId);
    if (!metric) throw new Error(`trial ${trial.trialId}: no metric in run ${input.run.runId}`);
    const review = reviewByTrial.get(trial.trialId);

    if (review?.decision === "exclude") {
      return { trial, metric, eligible: false, basis: null, excludeReason: `治疗师排除：${review.reason}` };
    }
    if (trial.status === "interrupted") {
      return { trial, metric, eligible: false, basis: null, excludeReason: "试次中断且未被补做采用" };
    }
    if (trial.status === "make-up") {
      if (review?.decision === "confirm-make-up") {
        return { trial, metric, eligible: true, basis: "confirmed-make-up", excludeReason: null };
      }
      return { trial, metric, eligible: false, basis: null, excludeReason: "补做试次未经治疗师确认" };
    }
    return { trial, metric, eligible: true, basis: "completed", excludeReason: null };
  });

  // 同一 (任务, 佩戴侧) 只允许选一个试次；禁止左右腕拼接。
  const groups = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const key = `${c.trial.task}|${c.trial.side}`;
    const list = groups.get(key) ?? [];
    list.push(c);
    groups.set(key, list);
  }

  const selections: SummarySelection[] = [];
  const exclusions: SummaryExclusion[] = [];

  for (const [, list] of groups) {
    const eligible = list.filter((c) => c.eligible);
    for (const c of list) {
      if (!c.eligible) {
        exclusions.push({
          trialId: c.trial.trialId,
          task: c.trial.task,
          side: c.trial.side,
          reason: c.excludeReason!,
        });
      }
    }
    if (eligible.length === 0) continue;
    // 确定性选择：优先常规完成试次，其次确认补做；同basis取临床开始更早者。
    eligible.sort((a, b) => {
      if (a.basis !== b.basis) return a.basis === "completed" ? -1 : 1;
      return a.trial.clinicalStartAt < b.trial.clinicalStartAt ? -1 : 1;
    });
    const chosen = eligible[0]!;
    selections.push({
      task: chosen.trial.task,
      side: chosen.trial.side,
      chosenTrialId: chosen.trial.trialId,
      metricId: chosen.metric.metricId,
      runId: chosen.metric.runId,
      basis: chosen.basis!,
    });
  }

  selections.sort((a, b) => taskOrder(a.task) - taskOrder(b.task) || (a.side < b.side ? -1 : 1));
  exclusions.sort((a, b) => taskOrder(a.task) - taskOrder(b.task) || (a.side < b.side ? -1 : 1));

  const body = {
    patientId: input.patientId,
    visitId,
    protocolId,
    protocolVersion,
    algorithmVersion: input.run.algorithmVersion,
    parameterVersion: input.run.parameterVersion,
    inputManifestId: input.run.inputManifestId,
    selections,
    exclusions,
    reviewIds: input.reviews.map((r) => r.reviewId).sort(),
    authorId: input.authorId,
    createdAt: input.createdAt,
    ...(input.note !== undefined ? { note: input.note } : {}),
  };
  return { summaryId: contentId("summary", body), ...body };
}

function mustBeSingle<T>(values: T[], label: string): T {
  const first = values[0];
  if (first === undefined || values.some((v) => v !== first)) {
    throw new Error(`summary input must reference a single ${label}`);
  }
  return first;
}

export function taskOrder(task: string): number {
  return (["rest", "posture", "pronation-supination", "walk"] as const).indexOf(task as never);
}

// ── 签署：载荷字节冻结，重算不改写已签署内容 ───────────────────────────────

export interface SignerKey {
  signerId: string;
  publicKeyId: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
}

export function createSigner(signerId: string): SignerKey {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyId = `pk_${sha256Hex(publicKey.export({ format: "der", type: "spki" })).slice(0, 12)}`;
  return { signerId, publicKeyId, privateKey, publicKey };
}

export function signSummary(summary: ClinicalSummary, signer: SignerKey, signedAt: string): SignedClinicalSummary {
  const payloadCanonicalJson = canonicalJson(summary);
  const canonicalSha256 = sha256Hex(payloadCanonicalJson);
  const signature = signBytes(null, Buffer.from(payloadCanonicalJson, "utf8"), signer.privateKey)
    .toString("hex");
  return {
    summaryId: summary.summaryId,
    signerId: signer.signerId,
    publicKeyId: signer.publicKeyId,
    signedAt,
    canonicalSha256,
    signature,
    payloadCanonicalJson,
  };
}

/** 校验：签名有效、载荷摘要一致，并原样还原因署而冻结的摘要对象。 */
export function openSignedSummary(signed: SignedClinicalSummary, signer: SignerKey): {
  summary: ClinicalSummary;
  verified: boolean;
} {
  const payload = Buffer.from(signed.payloadCanonicalJson, "utf8");
  const hashOk = sha256Hex(payload.toString("utf8")) === signed.canonicalSha256;
  const signatureOk = verifySig(
    null,
    payload,
    signer.publicKey,
    Buffer.from(signed.signature, "hex"),
  );
  const summary = JSON.parse(payload.toString("utf8")) as ClinicalSummary;
  if (summary.summaryId !== signed.summaryId) {
    throw new Error("signed payload summaryId disagrees with envelope");
  }
  return { summary, verified: hashOk && signatureOk };
}
