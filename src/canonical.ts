import { createHash } from "node:crypto";

/**
 * 确定性规范化 JSON：对象键排序、无多余空白。
 * 所有内容寻址（清单、指标、签署载荷）都基于该编码，保证同输入同摘要。
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return canonicalScalar(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

function canonicalScalar(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  throw new TypeError(`Unsupported value in canonical JSON: ${typeof value}`);
}

export function sha256Hex(value: unknown): string {
  const body = typeof value === "string" ? value : canonicalJson(value);
  return createHash("sha256").update(body, "utf8").digest("hex");
}

export function sha256Bytes(bytes: Uint8Array | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** 内容寻址 ID：kind/hex 前缀，方便日志与追溯。 */
export function contentId(prefix: string, value: unknown): string {
  return `${prefix}_${sha256Hex(value).slice(0, 16)}`;
}

/** 确定性伪随机发生器（mulberry32）：合成信号必须可复现。 */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
