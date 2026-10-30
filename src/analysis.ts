import type { RecordEntry } from "./metrics";
import { normalizeScenario, SimulationEngine, SECOND } from "./engine";
import type { Scenario } from "./engine";
import { groundLabel } from "./groundPresentation";
import type { ServiceType } from "./routing";
import type { ProfileMode } from "./performance";

export type AnalysisSample = ReturnType<SimulationEngine["analysisSnapshot"]>;
export type LogicalResult = ReturnType<SimulationEngine["result"]>;
export type Distribution = {
  count: number;
  mean: number | null;
  median: number | null;
  p95: number | null;
  min: number | null;
  max: number | null;
};
export function distribution(values: number[]): Distribution {
  if (values.some((v) => !Number.isFinite(v)))
    throw new Error("Non-finite analysis value");
  const sorted = [...values].sort((a, b) => a - b),
    n = sorted.length;
  return {
    count: n,
    mean: n ? sorted.reduce((s, v) => s + v, 0) / n : null,
    median: n
      ? n % 2
        ? sorted[n >> 1]
        : (sorted[n / 2 - 1] + sorted[n / 2]) / 2
      : null,
    p95: n ? sorted[Math.ceil(n * 0.95) - 1] : null,
    min: n ? sorted[0] : null,
    max: n ? sorted[n - 1] : null,
  };
}
export function comparisonScenario(
  input: Scenario,
  algorithm: "bfs" | "mcsr",
  service = input.routing.service,
): Scenario {
  return normalizeScenario({
    ...structuredClone(input),
    routing: { ...input.routing, algorithm, service },
  });
}
export function environmentKey(input: Scenario): string {
  const { algorithm: _algorithm, ...routing } = input.routing;
  function stable(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => [k, stable(v)]),
      );
    return value;
  }
  return JSON.stringify(stable({ ...input, routing }));
}
export type AnalysisOutage = {
  scope: "isl" | "ground";
  id: number;
  startedUs: number;
  recoveredUs: number | null;
  censoredUs: number | null;
  detectedUs: number | null;
  sourceInformedUs: number | null;
  durationUs: number;
  mechanism: string | null;
  status: string;
  causes: string[];
};
export function summarize(result: LogicalResult, samples: AnalysisSample[]) {
  const valid = samples.filter((s) => s.available),
    metric = (
      key: "propagationDelayMs" | "availableBufferRatio" | "jitterMs",
    ) =>
      distribution(valid.flatMap((s) => (s.metrics ? [s.metrics[key]] : [])));
  const stages: RecordEntry[] = [
    ...result.events.filter((e) =>
      /^(service-|route-|reserve-|notification-|ground-|srd-)|^link-(detected|down|up)/.test(
        e.type,
      ),
    ),
    ...result.serviceOutages
      .filter((o) => o.sourceInformedUs !== null)
      .map((o) => ({
        atUs: o.sourceInformedUs!,
        type: "source-informed",
        outageId: o.id,
      })),
    ...(result.groundAccessEvents ?? []).map((e) => ({
      atUs: e.atUs,
      type: "ground-" + e.kind,
      reason: `${groundLabel(e.role)} ${e.from ?? "none"} → ${e.to ?? "none"}`,
    })),
  ].sort((a, b) => a.atUs - b.atUs);
  const installs = result.events.filter(
    (e) => e.type === "route-installed" && !!e.path?.length,
  );
  let switches = 0,
    previous: number[] | null = null;
  for (const e of installs) {
    const path = e.path!;
    if (
      previous &&
      previous[0] === path[0] &&
      previous.at(-1) === path.at(-1) &&
      previous.join(":") !== path.join(":")
    )
      switches++;
    previous = path;
  }
  const outages: AnalysisOutage[] = result.serviceOutages.map((o) => ({
    scope: "isl",
    id: o.id,
    startedUs: o.startedUs,
    recoveredUs: o.recoveredUs,
    censoredUs: o.censoredUs,
    detectedUs: o.detectedUs,
    sourceInformedUs: o.sourceInformedUs,
    durationUs: o.durationUs,
    mechanism: o.recoveryMechanism,
    status: o.status,
    causes: o.causeLinkIds,
  }));
  for (const [i, o] of (result.groundService?.outages ?? []).entries())
    outages.push({
      scope: "ground",
      id: i + 1,
      startedUs: o.startedUs,
      recoveredUs: o.recoveredUs,
      censoredUs: null,
      detectedUs: null,
      sourceInformedUs: null,
      durationUs: (o.recoveredUs ?? result.timeUs) - o.startedUs,
      mechanism: null,
      status:
        o.recoveredUs !== null
          ? "recovered"
          : result.completed
            ? "unrecovered"
            : "pending",
      causes: o.causes,
    });
  const mechanismRecovery = (mechanism: string) =>
    distribution(
      result.serviceOutages
        .filter(
          (o) =>
            o.reason !== "initial-unreachable" &&
            o.recoveredUs !== null &&
            o.recoveryMechanism === mechanism &&
            o.startedUs < result.timeUs,
        )
        .map((o) => o.recoveredUs! - o.startedUs),
    );
  const service = result.groundService ?? result;
  return {
    summary: {
      availability: service.availability,
      outageCount: service.outageCount,
      totalDowntimeUs: service.totalDowntimeUs,
      islAvailability: result.availability,
      monitoredUs: result.monitoredUs,
      censoredCount: result.censoredCount,
      recoveredCount: outages.filter(
        (o) =>
          o.startedUs < result.timeUs &&
          o.scope === (result.groundService ? "ground" : "isl") &&
          o.status === "recovered",
      ).length,
      unrecoveredCount: outages.filter(
        (o) =>
          o.startedUs < result.timeUs &&
          o.scope === (result.groundService ? "ground" : "isl") &&
          o.status === "unrecovered",
      ).length,
      accessDowntimeUs: result.groundService?.accessDowntimeUs ?? null,
      handoverDowntimeUs: result.groundService?.handoverDowntimeUs ?? null,
      islDowntimeUs:
        result.groundService?.islDowntimeUs ?? result.totalDowntimeUs,
      hops: distribution(
        valid.flatMap((s) => (s.hopCount === null ? [] : [s.hopCount])),
      ),
      delay: metric("propagationDelayMs"),
      buffer: metric("availableBufferRatio"),
      jitter: metric("jitterMs"),
      endToEndPropagation: distribution(
        valid.flatMap((s) =>
          s.endToEndPropagationMs === null ? [] : [s.endToEndPropagationMs],
        ),
      ),
      recoveryUs: distribution(
        outages
          .filter(
            (o) =>
              o.scope === (result.groundService ? "ground" : "isl") &&
              o.recoveredUs !== null &&
              o.startedUs < result.timeUs,
          )
          .map((o) => o.recoveredUs! - o.startedUs),
      ),
      reserveRecoveryUs: mechanismRecovery("reserve"),
      recalculationRecoveryUs: mechanismRecovery("recalculate"),
      physicalRecoveryUs: mechanismRecovery("physical-restoration"),
      calculations: result.routingEvaluations.length,
      recalculations: result.events.filter((e) => e.type === "route-started")
        .length,
      discarded: result.routingAnalyses.filter((a) => a.status === "discarded")
        .length,
      reserveInstalls: installs.filter((e) => e.mode === "reserve").length,
      pathSwitches: switches,
      initialCalculations: result.routingAnalyses.filter(
        (a) => a.mode === "initial",
      ).length,
      expandedStates:
        result.routingAlgorithm === "BFS"
          ? null
          : result.routingEvaluations.reduce(
              (s, e) => s + (e.search?.expandedStates ?? 0),
              0,
            ),
      boundedPruned:
        result.routingAlgorithm === "BFS"
          ? null
          : result.routingEvaluations.reduce(
              (s, e) => s + (e.search?.boundedPruned ?? 0),
              0,
            ),
      traceOmitted: result.mcsr?.control?.traceOmitted ?? 0,
    },
    outages,
    stages,
    control: result.mcsr?.control?.stats ?? null,
    decisions: result.routingAnalyses.map((a) => ({
      id: a.id,
      atUs: a.atUs,
      mode: a.mode,
      status: a.status,
      trigger: a.trigger,
      selectedId: a.selectedId,
      selected: a.candidates.find((c) => c.id === a.selectedId) ?? null,
      candidateCount: a.candidates.length,
      search: a.search ?? null,
      reasons: Object.fromEntries(
        [...new Set(a.candidates.map((c) => c.reason))].map((reason) => [
          reason,
          a.candidates.filter((c) => c.reason === reason).length,
        ]),
      ),
    })),
  };
}
export type AnalysisRun = Omit<ReturnType<typeof summarize>, "summary"> & {
  summary: ReturnType<typeof summarize>["summary"] | null;
  id: string;
  algorithm: "bfs" | "mcsr";
  service: ServiceType;
  repetition: number;
  scenario: Scenario;
  status: "completed" | "failed";
  error: string | null;
  failureAtUs: number | null;
  samples: AnalysisSample[];
  performance: {
    wallMs: number;
    samplingMs: number;
    routingMs: number;
    profile: ReturnType<SimulationEngine["performanceReport"]>;
  };
  inputHash?: string;
  logicalHash?: string;
  rawResultFile?: string;
};
export type ComparisonReport = {
  analysisVersion: 1;
  createdAt: string;
  metadata: Record<string, unknown>;
  sampleIntervalUs: number;
  runs: AnalysisRun[];
};
export function runAnalysis(
  input: Scenario,
  options: {
    budget?: number;
    sampleIntervalUs?: number;
    profile?: ProfileMode;
  } = {},
) {
  const interval = options.sampleIntervalUs ?? SECOND,
    budget = options.budget ?? 500;
  if (
    !Number.isSafeInteger(interval) ||
    interval < 1 ||
    !Number.isSafeInteger(budget) ||
    budget < 1
  )
    throw new Error("Invalid analysis budget or interval");
  const started = performance.now(),
    samples: AnalysisSample[] = [];
  const engine = new SimulationEngine(input, undefined, true, {
    render: false,
    profile: options.profile ?? "off",
  });
  let samplingMs = 0;
  try {
    for (
      let target = 0;
      ;
      target = Math.min(input.durationUs, target + interval)
    ) {
      while (!engine.advanceTo(target, budget)) engine.drainDeltas();
      if (target < input.durationUs) {
        const t = performance.now();
        samples.push(engine.analysisSnapshot());
        samplingMs += performance.now() - t;
      }
      if (target === input.durationUs) break;
    }
  } catch (e) {
    if (!engine.failure) throw e;
  }
  const result = engine.result();
  return {
    result,
    samples,
    ...summarize(result, samples),
    performance: {
      wallMs: performance.now() - started,
      samplingMs,
      routingMs: engine.profiling.reduce((s, p) => s + p.wallMs, 0),
      profile: engine.performanceReport(),
    },
  };
}

export function repeatSummary(runs: AnalysisRun[]) {
  const keys = [...new Set(runs.map((r) => `${r.algorithm}:${r.service}`))];
  return keys.map((key) => {
    const group = runs.filter((r) => `${r.algorithm}:${r.service}` === key),
      completed = group.filter((r) => r.status === "completed");
    return {
      key,
      completed: completed.length,
      failed: group.length - completed.length,
      wallMs: distribution(completed.map((r) => r.performance.wallMs)),
      logicalMatch:
        completed.length > 1
          ? new Set(completed.map((r) => r.logicalHash)).size === 1
          : null,
    };
  });
}
export function csv(rows: Record<string, unknown>[]): string {
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = (value: unknown) => {
    let text =
      value == null
        ? ""
        : typeof value === "object"
          ? JSON.stringify(value)
          : String(value);
    if (typeof value === "string" && /^[=+@\-\t\r]/.test(text))
      text = "'" + text;
    return /[",\n\r]/.test(text)
      ? '"' + text.replaceAll('"', '""') + '"'
      : text;
  };
  return (
    [
      keys.map(cell).join(","),
      ...rows.map((r) => keys.map((k) => cell(r[k])).join(",")),
    ].join("\r\n") + "\r\n"
  );
}
export function validateComparison(value: unknown): ComparisonReport {
  const bad = () => {
    throw new Error("유효하지 않은 비교 보고서입니다.");
  };
  const finite = (n: unknown, minimum = 0): n is number =>
    typeof n === "number" && Number.isFinite(n) && n >= minimum;
  const object = (v: unknown): v is Record<string, any> =>
    !!v && typeof v === "object" && !Array.isArray(v);
  if (
    !object(value) ||
    value.analysisVersion !== 1 ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    !object(value.metadata) ||
    !Number.isSafeInteger(value.sampleIntervalUs) ||
    value.sampleIntervalUs < 1 ||
    !Array.isArray(value.runs) ||
    !value.runs.length
  )
    return bad();
  if (
    value.metadata.expectedRuns !== undefined &&
    (!Number.isSafeInteger(value.metadata.expectedRuns) ||
      value.metadata.expectedRuns !== value.runs.length)
  )
    return bad();
  const ids = new Set<string>(),
    environments = new Map<string, string>(),
    pairs = new Map<string, Set<string>>();
  for (const run of value.runs) {
    if (
      !object(run) ||
      typeof run.id !== "string" ||
      ids.has(run.id) ||
      !["bfs", "mcsr"].includes(run.algorithm) ||
      !["LS", "TS", "HR"].includes(run.service) ||
      !Number.isSafeInteger(run.repetition) ||
      run.repetition < 1 ||
      !["completed", "failed"].includes(run.status)
    )
      return bad();
    ids.add(run.id);
    const pairKey = `${run.service}:${run.repetition}`,
      pair = pairs.get(pairKey) ?? new Set<string>();
    if (pair.has(run.algorithm)) return bad();
    pair.add(run.algorithm);
    pairs.set(pairKey, pair);
    if (!object(run.scenario) || run.scenario.schemaVersion !== 9) return bad();
    const scenario = normalizeScenario(run.scenario);
    if (
      scenario.routing.algorithm !== run.algorithm ||
      scenario.routing.service !== run.service
    )
      return bad();
    const key = environmentKey(scenario),
      previous = environments.get(run.service);
    if (previous && previous !== key) return bad();
    environments.set(run.service, key);
    const time = (t: unknown): t is number =>
      finite(t) && Number.isSafeInteger(t) && t <= scenario.durationUs;
    const path = (p: unknown): p is number[] =>
      Array.isArray(p) &&
      p.every(
        (n) =>
          Number.isInteger(n) &&
          n >= 0 &&
          n < scenario.config.planes * scenario.config.perPlane,
      ) &&
      new Set(p).size === p.length;
    const metrics = (m: unknown) =>
      object(m) &&
      finite(m.propagationDelayMs) &&
      finite(m.availableBufferRatio) &&
      m.availableBufferRatio <= 1 &&
      finite(m.jitterMs);
    if (
      !object(run.performance) ||
      !["wallMs", "samplingMs", "routingMs"].every((k) =>
        finite(run.performance[k]),
      ) ||
      !Array.isArray(run.samples) ||
      !Array.isArray(run.outages) ||
      !Array.isArray(run.stages) ||
      !Array.isArray(run.decisions)
    )
      return bad();
    if (
      run.status === "completed" &&
      (run.summary === null ||
        run.error !== null ||
        run.failureAtUs !== null ||
        typeof run.logicalHash !== "string" ||
        !/^[a-f0-9]{64}$/.test(run.logicalHash))
    )
      return bad();
    if (
      run.status === "failed" &&
      (typeof run.error !== "string" || !time(run.failureAtUs))
    )
      return bad();
    if (run.summary !== null) {
      if (!object(run.summary)) return bad();
      for (const k of ["availability", "islAvailability"])
        if (
          run.summary[k] !== null &&
          (!finite(run.summary[k]) || run.summary[k] > 1)
        )
          return bad();
      for (const k of [
        "outageCount",
        "totalDowntimeUs",
        "monitoredUs",
        "censoredCount",
        "recoveredCount",
        "unrecoveredCount",
        "calculations",
        "recalculations",
        "discarded",
        "reserveInstalls",
        "pathSwitches",
        "initialCalculations",
        "traceOmitted",
      ])
        if (!finite(run.summary[k])) return bad();
      for (const k of [
        "accessDowntimeUs",
        "handoverDowntimeUs",
        "islDowntimeUs",
        "expandedStates",
        "boundedPruned",
      ])
        if (run.summary[k] !== null && !finite(run.summary[k])) return bad();
      for (const k of [
        "hops",
        "delay",
        "buffer",
        "jitter",
        "endToEndPropagation",
        "recoveryUs",
        "reserveRecoveryUs",
        "recalculationRecoveryUs",
        "physicalRecoveryUs",
      ]) {
        const d = run.summary[k];
        if (
          !object(d) ||
          !Number.isSafeInteger(d.count) ||
          d.count < 0 ||
          !["mean", "median", "p95", "min", "max"].every((k) =>
            d.count === 0 ? d[k] === null : finite(d[k]),
          )
        )
          return bad();
      }
    }
    let last = -1;
    for (const sample of run.samples) {
      if (
        !object(sample) ||
        !time(sample.timeUs) ||
        sample.timeUs >= scenario.durationUs ||
        sample.timeUs <= last ||
        !path(sample.path) ||
        typeof sample.available !== "boolean" ||
        (sample.hopCount !== null && !finite(sample.hopCount)) ||
        (sample.metrics !== null && !metrics(sample.metrics)) ||
        (sample.endToEndPropagationMs !== null &&
          !finite(sample.endToEndPropagationMs))
      )
        return bad();
      last = sample.timeUs;
    }
    for (const o of run.outages) {
      if (
        !object(o) ||
        !["isl", "ground"].includes(o.scope) ||
        !Number.isSafeInteger(o.id) ||
        !time(o.startedUs) ||
        !finite(o.durationUs) ||
        !["recovered", "censored", "unrecovered", "pending"].includes(
          o.status,
        ) ||
        !Array.isArray(o.causes) ||
        !o.causes.every((s: unknown) => typeof s === "string") ||
        !(o.mechanism === null || typeof o.mechanism === "string")
      )
        return bad();
      for (const k of [
        "recoveredUs",
        "censoredUs",
        "detectedUs",
        "sourceInformedUs",
      ])
        if (o[k] !== null && (!time(o[k]) || o[k] < o.startedUs)) return bad();
    }
    last = -1;
    for (const e of run.stages) {
      if (
        !object(e) ||
        !time(e.atUs) ||
        e.atUs < last ||
        typeof e.type !== "string" ||
        (e.path !== undefined && !path(e.path)) ||
        (e.reason !== undefined && typeof e.reason !== "string")
      )
        return bad();
      last = e.atUs;
    }
    for (const d of run.decisions) {
      if (
        !object(d) ||
        !time(d.atUs) ||
        !Number.isSafeInteger(d.id) ||
        !["initial", "reserve", "recalculate"].includes(d.mode) ||
        !["pending", "installed", "retained", "discarded"].includes(d.status) ||
        typeof d.trigger !== "string" ||
        !(d.selectedId === null || typeof d.selectedId === "string") ||
        !Number.isSafeInteger(d.candidateCount) ||
        d.candidateCount < 0 ||
        !object(d.reasons) ||
        !Object.values(d.reasons).every((v) => finite(v))
      )
        return bad();
      if (
        d.selected !== null &&
        (!object(d.selected) ||
          !path(d.selected.nodes) ||
          typeof d.selected.reason !== "string" ||
          (d.selected.metrics !== null && !metrics(d.selected.metrics)))
      )
        return bad();
    }
    if (
      run.control !== null &&
      (!object(run.control) ||
        ![
          "sentUpdates",
          "sentAcks",
          "deliveredUpdates",
          "appliedUpdates",
          "deliveredAcks",
          "acknowledged",
          "retries",
          "dropped",
          "expired",
          "eventCount",
        ].every(
          (k) => Number.isSafeInteger(run.control[k]) && run.control[k] >= 0,
        ))
    )
      return bad();
  }
  if ([...pairs.values()].some((pair) => pair.size !== 2)) return bad();
  return value as ComparisonReport;
}
