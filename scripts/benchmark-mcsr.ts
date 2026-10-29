import { readFileSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpus } from "node:os";
import { resolve, basename, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import type { SimulationEngine as Engine } from "../src/engine.ts";

const args = process.argv.slice(2);
function option(name: string, fallback: string) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith("--"))
    throw new Error(`Missing ${name} value`);
  return args.splice(index, 2)[1];
}
const engineFile = option("--engine", "src/engine.ts");
const seconds = option("--seconds", "original").split(",");
const repeats = Number(option("--repeat", "1"));
const budget = Number(option("--budget", "500"));
const profile = option("--profile", "off");
const render = option("--render", "on");
const directory = option(
  "--output",
  `artifacts/performance/${new Date().toISOString().replace(/[:.]/g, "-")}`,
);
if (
  !Number.isInteger(repeats) ||
  repeats < 1 ||
  !Number.isInteger(budget) ||
  budget < 1 ||
  !["off", "light", "detail"].includes(profile) ||
  !["on", "off"].includes(render) ||
  seconds.some(
    (s) => s !== "original" && (!Number.isFinite(Number(s)) || Number(s) <= 0),
  ) ||
  args.some((s) => s.startsWith("--"))
)
  throw new Error("Invalid benchmark arguments");
const { SimulationEngine, normalizeScenario } = await import(
  pathToFileURL(resolve(engineFile)).href
);
const files = args.length
  ? args
  : [
      "examples/mcsr-72-uniform.json",
      "examples/mcsr-72.json",
      "examples/mcsr-1584-uniform.json",
      "examples/mcsr-1584.json",
    ];
mkdirSync(directory, { recursive: true });
// Exclusive creation prevents a new experiment from replacing preserved measurements.
const manifest = resolve(directory, "report.json");
writeFileSync(manifest, "[]\n", { flag: "wx" });
function sourceDigest(directory: string): string {
  const digest = createHash("sha256");
  function walk(at: string, prefix = "") {
    for (const entry of readdirSync(at, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const relative = `${prefix}${entry.name}`;
      if (entry.isDirectory()) walk(resolve(at, entry.name), `${relative}/`);
      else
        digest.update(relative).update(readFileSync(resolve(at, entry.name)));
    }
  }
  walk(directory);
  return digest.digest("hex");
}
const metadata = {
  commit: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  dirty:
    execFileSync("git", ["status", "--porcelain"], {
      encoding: "utf8",
    }).trim() !== "",
  node: process.version,
  v8: process.versions.v8,
  cpu: cpus()[0]?.model,
  platform: process.platform,
  architecture: process.arch,
  flags: process.execArgv,
  engineFile,
  sourceTreeHash: sourceDigest(dirname(resolve(engineFile))),
  engineSourceHash: createHash("sha256")
    .update(readFileSync(engineFile))
    .digest("hex"),
  profile,
  render,
  budget,
  repeats,
  startedAt: new Date().toISOString(),
};
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const reports: Record<string, unknown>[] = [];
for (const file of files)
  for (const duration of seconds)
    for (let repetition = 1; repetition <= repeats; repetition++) {
      const scenario = normalizeScenario(
        JSON.parse(readFileSync(file, "utf8")),
      );
      if (duration !== "original") {
        scenario.durationUs = Math.min(
          scenario.durationUs,
          Math.round(Number(duration) * 1e6),
        );
        scenario.failures = scenario.failures.filter(
          (f: { atUs: number }) => f.atUs <= scenario.durationUs,
        );
        scenario.linkMetricUpdates = scenario.linkMetricUpdates.filter(
          (f: { atUs: number }) => f.atUs <= scenario.durationUs,
        );
      }
      let peakHeap = process.memoryUsage().heapUsed;
      const started = performance.now();
      const engine: Engine = new SimulationEngine(scenario, undefined, true, {
        profile,
        render: render === "on",
      });
      const constructorMs = performance.now() - started;
      peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
      const advanceStarted = performance.now();
      let resumptions = 0,
        last = -1;
      for (;;) {
        const done = engine.advanceTo(scenario.durationUs, budget);
        engine.drainDeltas();
        if (resumptions % 32 === 0 || done)
          peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
        if (done) break;
        resumptions++;
        const progress = Math.floor(engine.nowUs / 30000000) * 30;
        if (progress > last) {
          last = progress;
          console.error(`${file} / ${duration}s #${repetition}: ${progress}s`);
        }
      }
      const advanceMs = performance.now() - advanceStarted;
      const exportStarted = performance.now(),
        result = engine.result();
      const exportMs = performance.now() - exportStarted;
      const serializationStarted = performance.now(),
        logicalJson = JSON.stringify(result);
      const serializationMs = performance.now() - serializationStarted;
      if (!result.completed || !result.validForAnalysis)
        throw new Error(`Incomplete/invalid experiment: ${file}`);
      const previous = reports.find(
        (r) => r.inputHash === hash(JSON.stringify(scenario)),
      );
      if (previous && previous.logicalHash !== hash(logicalJson))
        throw new Error(`Non-deterministic logical result: ${file}`);
      const finalHeap = process.memoryUsage().heapUsed;
      peakHeap = Math.max(peakHeap, finalHeap);
      const report = {
        ...metadata,
        file,
        repetition,
        durationUs: scenario.durationUs,
        inputHash: hash(JSON.stringify(scenario)),
        logicalHash: hash(logicalJson),
        modelVersion: result.modelVersion,
        valid: result.validForAnalysis,
        completed: result.completed,
        constructorMs,
        advanceMs,
        exportMs,
        serializationMs,
        wallMs: performance.now() - started,
        activeRoutingMs: engine.profiling.reduce((sum, p) => sum + p.wallMs, 0),
        calculations: engine.profiling.length,
        maxCalculationMs: engine.profiling.reduce(
          (max, p) => Math.max(max, p.wallMs),
          0,
        ),
        pathNodes: result.path.length,
        heapUsedBytes: finalHeap,
        resumptions,
        sampledPeakHeapBytes: peakHeap,
        finalHeapUsedBytes: finalHeap,
        processLifetimeMaxRssBytes: process.resourceUsage().maxRSS * 1024,
        performance:
          "performanceReport" in engine
            ? (
                engine as Engine & { performanceReport(): unknown }
              ).performanceReport()
            : null,
        control: result.mcsr?.control?.stats,
        traceOmitted: result.mcsr?.control?.traceOmitted,
        outageCount: result.outageCount,
        availability: result.availability,
        recoveries: result.serviceOutages.map((o) => ({
          startedUs: o.startedUs,
          recoveredUs: o.recoveredUs,
          mechanism: o.recoveryMechanism,
        })),
        boundedPruned: result.routingAnalyses.reduce(
          (sum, a) => sum + (a.search?.boundedPruned ?? 0),
          0,
        ),
        allCandidatesGuaranteed:
          result.routingAlgorithm === "MCSR" &&
          scenario.mcsrSearch.mode === "reference",
      };
      const name = `${reports.length}-${basename(file, ".json")}-${scenario.durationUs}-${repetition}`;
      writeFileSync(
        resolve(directory, `${name}.result.json.gz`),
        gzipSync(logicalJson),
        { flag: "wx" },
      );
      reports.push(report);
      writeFileSync(manifest, JSON.stringify(reports, null, 2) + "\n");
      console.error(JSON.stringify(report));
    }
const groups = new Map<string, typeof reports>();
for (const r of reports) {
  const key = `${r.file}:${r.durationUs}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key)!.push(r);
}
const summary = [...groups].map(([caseName, rows]) => {
  const values = rows.map((r) => r.wallMs as number).sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return {
    caseName,
    repeats: values.length,
    medianMs:
      values.length % 2
        ? values[middle]
        : (values[middle - 1] + values[middle]) / 2,
    minMs: values[0],
    maxMs: values.at(-1),
    deterministic: new Set(rows.map((r) => r.logicalHash)).size === 1,
  };
});
writeFileSync(
  resolve(directory, "summary.json"),
  JSON.stringify(summary, null, 2) + "\n",
  { flag: "wx" },
);
console.error(JSON.stringify(summary));
