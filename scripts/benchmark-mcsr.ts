import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { SimulationEngine } from "../src/engine.ts";
const files = process.argv.slice(2);
const reports = [];
for (const file of files.length
  ? files
  : [
      "examples/mcsr-72-uniform.json",
      "examples/mcsr-72.json",
      "examples/mcsr-1584-uniform.json",
      "examples/mcsr-1584.json",
    ]) {
  const s = JSON.parse(readFileSync(file, "utf8"));
  const started = performance.now();
  const e = new SimulationEngine(s, undefined, true);
  const constructorMs = performance.now() - started;
  let last = -1,
    ticks = 0;
  while (!e.advanceTo(s.durationUs, 500)) {
    e.drainDeltas();
    ticks++;
    const seconds = Math.floor(e.nowUs / 30000000) * 30;
    if (seconds > last) {
      last = seconds;
      console.error(`${file}: ${seconds}s`);
    }
  }
  e.drainDeltas();
  const result = e.result(),
    control = result.mcsr?.control;
  const report = {
    file,
    modelVersion: result.modelVersion,
    durationUs: s.durationUs,
    valid: result.validForAnalysis,
    completed: result.completed,
    constructorMs,
    wallMs: performance.now() - started,
    activeRoutingMs: e.profiling.reduce((sum, p) => sum + p.wallMs, 0),
    calculations: e.profiling.length,
    maxCalculationMs: Math.max(...e.profiling.map((p) => p.wallMs)),
    resumptions: ticks,
    heapUsedBytes: process.memoryUsage().heapUsed,
    outageCount: result.outageCount,
    availability: result.availability,
    recoveries: result.serviceOutages.map((o) => ({
      startedUs: o.startedUs,
      recoveredUs: o.recoveredUs,
      mechanism: o.recoveryMechanism,
    })),
    pathNodes: result.path.length,
    control: control?.stats,
    traceOmitted: control?.traceOmitted,
    boundedPruned: result.routingAnalyses.reduce(
      (sum, a) => sum + (a.search?.boundedPruned ?? 0),
      0,
    ),
    allCandidatesGuaranteed: false,
  };
  reports.push(report);
  mkdirSync("artifacts", { recursive: true });
  writeFileSync(
    "artifacts/mcsr-scale-benchmark.json",
    JSON.stringify(reports, null, 2) + "\n",
  );
  console.error(JSON.stringify(report));
}
