import { createHash } from "node:crypto";

/**
 * 规范化 JSON：对象键排序、剔除 undefined，数组保序。
 * 同一逻辑值无论键序如何都得到同一字符串，是内容哈希的基础。
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortValue(v);
    }
    return out;
  }
  return value;
}

export function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

/** 任意可 JSON 化内容的内容哈希。 */
export function contentHashOf(value: unknown): string {
  return sha256Hex(canonicalize(value));
}

/** 深冻结：签署后的摘要、发布后的方案、清单等不可再被改写。 */
export function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      freezeDeep((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}
