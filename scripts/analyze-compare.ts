import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpus } from "node:os";
import { resolve, dirname } from "node:path";
import { gzipSync } from "node:zlib";
import { normalizeScenario, MODEL_VERSION } from "../src/engine.ts";
import {
  comparisonScenario,
  environmentKey,
  runAnalysis,
  csv,
  repeatSummary,
  validateComparison,
} from "../src/analysis.ts";
import type { AnalysisRun, ComparisonReport } from "../src/analysis.ts";
import type { ServiceType } from "../src/routing.ts";
const args = process.argv.slice(2);
function option(name: string, fallback: string) {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  if (!args[i + 1] || args[i + 1].startsWith("--"))
    throw new Error(`Missing ${name} value`);
  return args.splice(i, 2)[1];
}
const output = option("--output", `artifacts/analysis/${Date.now()}`),
  seconds = option("--seconds", "original"),
  repeats = Number(option("--repeat", "1")),
  servicesOption = option("--services", "current"),
  profile = option("--profile", "off");
if (
  args.length !== 1 ||
  args[0].startsWith("--") ||
  !Number.isSafeInteger(repeats) ||
  repeats < 1 ||
  !["off", "light", "detail"].includes(profile) ||
  (seconds !== "original" &&
    (!Number.isFinite(Number(seconds)) || Number(seconds) <= 0))
)
  throw new Error(
    "Usage: analyze:compare -- scenario.json [--output directory] [--seconds N] [--repeat N] [--services LS,TS,HR] [--profile off|light|detail]",
  );
const base = normalizeScenario(JSON.parse(readFileSync(args[0], "utf8")));
if (seconds !== "original") {
  base.durationUs = Math.min(
    base.durationUs,
    Math.round(Number(seconds) * 1e6),
  );
  base.failures = base.failures.filter((e) => e.atUs <= base.durationUs);
  base.linkMetricUpdates = base.linkMetricUpdates.filter(
    (e) => e.atUs <= base.durationUs,
  );
}
const services = (
  servicesOption === "current"
    ? [base.routing.service]
    : servicesOption.split(",")
) as ServiceType[];
if (
  !services.length ||
  new Set(services).size !== services.length ||
  services.some((s) => !["LS", "TS", "HR"].includes(s))
)
  throw new Error("Invalid service list");
const sha = (text: string | Buffer) =>
  createHash("sha256").update(text).digest("hex");
function sourceHash(directory: string): string {
  const hash = createHash("sha256");
  function walk(at: string, prefix = "") {
    for (const entry of readdirSync(at, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const key = prefix + entry.name;
      if (entry.isDirectory()) walk(resolve(at, entry.name), key + "/");
      else hash.update(key).update(readFileSync(resolve(at, entry.name)));
    }
  }
  walk(directory);
  return hash.digest("hex");
}
const metadata = {
  modelVersion: MODEL_VERSION,
  expectedRuns: services.length * repeats * 2,
  commonEnvironmentHashes: Object.fromEntries(
    services.map((service) => [
      service,
      sha(environmentKey(comparisonScenario(base, "bfs", service))),
    ]),
  ),
  commit: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  dirty: !!execFileSync("git", ["status", "--porcelain"], {
    encoding: "utf8",
  }).trim(),
  sourceTreeHash: sourceHash("src"),
  node: process.version,
  v8: process.versions.v8,
  cpu: cpus()[0]?.model,
  platform: process.platform,
  repeats,
  profile,
  units: {
    logicalTime: "microseconds",
    executionTime: "milliseconds",
    delay: "milliseconds",
    jitter: "milliseconds",
    buffer: "ratio",
    hops: "ISL edges",
  },
  timelineScope:
    "service stages, source-informed outage timestamps and SRD-local updates; full CSIB reception/control records remain in raw results",
  informationModels: {
    bfs: "global-known-state; no modeled DS/CSIB transport",
    mcsr: "domain-local observations and received CSIB; configured fixed or actual ISL transport",
  },
  metricDefinitions:
    "global expanded/pruned counters only; local summary search fields reference cached advertisements, not executed work; 1-second samples in [0,T); propagation only, synthetic buffer/jitter inputs; exact event-based service availability; CPU wall time is not logical recovery time; no packet latency/loss/throughput or total network control bytes measured",
};
for (const service of services) comparisonScenario(base, "mcsr", service);
mkdirSync(dirname(resolve(output)), { recursive: true });
mkdirSync(output); // Fail before writing if a previous experiment already occupies this path.
const report: ComparisonReport = {
  analysisVersion: 1,
  createdAt: new Date().toISOString(),
  metadata,
  sampleIntervalUs: 1000000,
  runs: [],
};
for (const service of services)
  for (let repetition = 1; repetition <= repeats; repetition++)
    for (const algorithm of ["bfs", "mcsr"] as const) {
      const scenario = comparisonScenario(base, algorithm, service),
        id = `${service}-${repetition}-${algorithm}`;
      console.error(`${id}: ${scenario.durationUs / 1e6}s`);
      const common = {
        id,
        algorithm,
        service,
        repetition,
        scenario,
        inputHash: sha(JSON.stringify(scenario)),
        rawResultFile: `${id}.result.json.gz`,
      };
      let run: AnalysisRun, raw: unknown;
      const runStarted = performance.now();
      try {
        const { result, ...analysis } = runAnalysis(scenario, {
          profile: profile as "off" | "light" | "detail",
        });
        raw = { scenario, result };
        run = {
          ...common,
          ...analysis,
          logicalHash: sha(JSON.stringify(result)),
          status:
            result.completed && result.validForAnalysis
              ? "completed"
              : "failed",
          error: result.failure?.message ?? null,
          failureAtUs: result.failure?.atUs ?? null,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        raw = {
          scenario,
          error: message,
          code:
            error && typeof error === "object" && "code" in error
              ? error.code
              : "initialization-failed",
        };
        run = {
          ...common,
          status: "failed",
          error: message,
          failureAtUs: 0,
          summary: null,
          samples: [],
          outages: [],
          stages: [],
          decisions: [],
          control: null,
          performance: {
            wallMs: performance.now() - runStarted,
            samplingMs: 0,
            routingMs: 0,
            profile: null,
          },
        };
      }
      writeFileSync(
        resolve(output, common.rawResultFile),
        gzipSync(JSON.stringify(raw)),
        { flag: "wx" },
      );
      report.runs.push(run);
      writeFileSync(resolve(output, "comparison.json"), JSON.stringify(report));
    }
for (const service of services) {
  const runs = report.runs.filter((r) => r.service === service);
  if (new Set(runs.map((r) => environmentKey(r.scenario))).size !== 1)
    throw new Error("Comparison environments differ");
}
function flatten(
  value: Record<string, unknown>,
  prefix = "",
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, v]) =>
      v && typeof v === "object" && !Array.isArray(v)
        ? Object.entries(
            flatten(v as Record<string, unknown>, prefix + key + "."),
          )
        : [[prefix + key, v]],
    ),
  );
}
const groups = repeatSummary(report.runs);
report.metadata.repeatSummary = groups;
validateComparison(report);
writeFileSync(resolve(output, "comparison.json"), JSON.stringify(report));
writeFileSync(
  resolve(output, "summary.csv"),
  csv(
    report.runs.map((r) =>
      flatten({
        id: r.id,
        algorithm: r.algorithm,
        service: r.service,
        repetition: r.repetition,
        status: r.status,
        error: r.error,
        ...r.summary,
        ...r.performance,
        control: r.control,
      }),
    ),
  ),
);
writeFileSync(
  resolve(output, "samples.csv"),
  csv(
    report.runs.flatMap((r) =>
      r.samples.map((s) => ({
        id: r.id,
        algorithm: r.algorithm,
        service: r.service,
        repetition: r.repetition,
        timeUs: s.timeUs,
        source: s.source,
        target: s.target,
        available: s.available,
        path: s.path,
        hopCount: s.hopCount,
        delayMs: s.metrics?.propagationDelayMs,
        bufferRatio: s.metrics?.availableBufferRatio,
        jitterMs: s.metrics?.jitterMs,
        endToEndPropagationMs: s.endToEndPropagationMs,
      })),
    ),
  ),
);
writeFileSync(
  resolve(output, "outages.csv"),
  csv(
    report.runs.flatMap((r) =>
      r.outages.map((o) => ({
        runId: r.id,
        algorithm: r.algorithm,
        service: r.service,
        repetition: r.repetition,
        ...o,
      })),
    ),
  ),
);
console.log(JSON.stringify({ output, groups }, null, 2));
if (
  report.runs.some((r) => r.status === "failed") ||
  groups.some((g) => g.logicalMatch === false)
)
  process.exitCode = 1;
