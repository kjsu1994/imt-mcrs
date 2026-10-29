import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const [beforeDir, afterDir] = process.argv.slice(2);
if (!beforeDir || !afterDir)
  throw new Error(
    "Usage: tsx scripts/compare-benchmarks.ts before-directory after-directory",
  );
type Row = {
  file: string;
  durationUs: number;
  inputHash: string;
  logicalHash: string;
  wallMs: number;
  activeRoutingMs: number;
  sampledPeakHeapBytes: number;
  repetition: number;
};
const read = (directory: string): Row[] =>
  JSON.parse(readFileSync(resolve(directory, "report.json"), "utf8"));
const before = read(beforeDir),
  after = read(afterDir);
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b),
    mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const inputHashes = new Set(after.map((r) => r.inputHash));
const summaries = [];
for (const inputHash of inputHashes) {
  const old = before.filter((r) => r.inputHash === inputHash),
    next = after.filter((r) => r.inputHash === inputHash);
  assert.ok(
    old.length,
    `Missing baseline for ${next[0].file} / ${next[0].durationUs}`,
  );
  assert.equal(
    new Set([...old, ...next].map((r) => r.logicalHash)).size,
    1,
    `Logical result changed: ${next[0].file} / ${next[0].durationUs}`,
  );
  const baselineMs = median(old.map((r) => r.wallMs)),
    optimizedMs = median(next.map((r) => r.wallMs));
  summaries.push({
    file: next[0].file,
    durationUs: next[0].durationUs,
    beforeRepeats: old.length,
    afterRepeats: next.length,
    baselineMs,
    optimizedMs,
    improvementPercent: (100 * (baselineMs - optimizedMs)) / baselineMs,
    logicalMatch: true,
  });
}
// Hash equality covers the complete exported logical result, including retained trace order.
assert.ok(readdirSync(beforeDir).some((f) => f.endsWith(".result.json.gz")));
assert.ok(readdirSync(afterDir).some((f) => f.endsWith(".result.json.gz")));
console.log(JSON.stringify(summaries, null, 2));
