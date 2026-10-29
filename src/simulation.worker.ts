import type { ProfileMode } from "./performance";
import type { WorkerPerformance } from "./browserPerformance";
import { SimulationEngine } from "./engine";
import type { Command, Reply } from "./protocol";
const port = self as unknown as {
  onmessage: ((e: MessageEvent<Command>) => void) | null;
  postMessage: (reply: Reply) => void;
};
let timer: ReturnType<typeof setTimeout>;
function schedulePump(delay: number) {
  clearTimeout(timer);
  timer = setTimeout(pump, delay);
}
let engine: SimulationEngine | null = null,
  runId = 0,
  playing = false,
  speed = 10,
  target: number | null = null,
  anchorWall = 0,
  anchorUs = 0,
  lastSent = -Infinity,
  lastCheckpoint = -Infinity,
  lastMetrics = -1,
  lastFailureCount = -1,
  lastCompleted = false,
  pendingReset = false,
  pendingVerify = false,
  busyReported = false;
let profile: ProfileMode = "off";
const emptyPerformance = () => ({
  constructorMs: 0,
  activeMs: 0,
  maxSliceMs: 0,
  pumps: 0,
  commands: 0,
  maxCommandLatencyMs: 0,
});
let workerPerformance = emptyPerformance();
function resetPerformance(issuedAtMs?: number) {
  workerPerformance = emptyPerformance();
  workerPerformance.commands = 1;
  if (issuedAtMs !== undefined)
    workerPerformance.maxCommandLatencyMs = Math.max(
      0,
      performance.timeOrigin + performance.now() - issuedAtMs,
    );
}
function performanceReport(): WorkerPerformance | undefined {
  if (profile === "off") return undefined;
  const engineReport = engine?.performanceReport() ?? null;
  return {
    ...workerPerformance,
    engine: engineReport,
    eventsPerActiveSecond: workerPerformance.activeMs
      ? (1000 * (engineReport?.counters["events.executed"] ?? 0)) /
        workerPerformance.activeMs
      : null,
  };
}
const exportsPending: ("scenario" | "result")[] = [];
function anchor() {
  anchorWall = performance.now();
  anchorUs = engine?.nowUs ?? 0;
}
function send(reset = false, verify = false) {
  if (!engine) return;
  if (engine.needsWork) {
    pendingReset ||= reset;
    pendingVerify ||= verify;
    if (!busyReported) {
      port.postMessage({ type: "busy", runId });
      busyReported = true;
    }
    return;
  }
  busyReported = false;
  reset ||= pendingReset;
  verify ||= pendingVerify;
  pendingReset = false;
  pendingVerify = false;
  const now = performance.now();
  const { serviceOutages, linkFailures, mcsr, ...progress } = engine.progress();
  const completed =
    !engine.failure && engine.nowUs === engine.scenario.durationUs;
  const checkpoint =
    reset || verify || now - lastCheckpoint >= 5000
      ? engine.checkpoint()
      : undefined;
  const historiesChanged =
    !!checkpoint ||
    lastMetrics !== engine.metrics.events.length ||
    completed !== lastCompleted;
  const scenarioChanged =
    !!checkpoint || lastFailureCount !== engine.scenario.failures.length;
  const deltas = engine.drainDeltas();
  port.postMessage({
    type: "state",
    ...(profile !== "off" ? { performance: performanceReport() } : {}),
    runId,
    progress,
    busy: target !== null,
    playing,
    reset,
    deltas: reset ? [] : deltas,
    ...(checkpoint ? { checkpoint } : {}),
    ...(historiesChanged
      ? { histories: { serviceOutages, linkFailures } }
      : {}),
    ...(scenarioChanged ? { scenario: structuredClone(engine.scenario) } : {}),
  });
  if (checkpoint) lastCheckpoint = now;
  lastMetrics = engine.metrics.events.length;
  lastFailureCount = engine.scenario.failures.length;
  lastCompleted = completed;
  lastSent = now;
}
function fail(error: unknown, stop = true) {
  if (stop) {
    playing = false;
    target = null;
    if (engine?.failure) send(true);
  }
  port.postMessage({
    type: "error",
    runId,
    message: error instanceof Error ? error.message : String(error),
    fatal: stop,
  });
}
port.onmessage = ({ data: c }) => {
  try {
    if (profile !== "off") {
      workerPerformance.commands++;
      if (c.issuedAtMs !== undefined)
        workerPerformance.maxCommandLatencyMs = Math.max(
          workerPerformance.maxCommandLatencyMs,
          performance.timeOrigin + performance.now() - c.issuedAtMs,
        );
    }
    if (c.type === "load") {
      runId = c.runId;
      engine = null;
      exportsPending.length = 0;
      pendingReset = true;
      pendingVerify = false;
      busyReported = false;
      profile = c.profile ?? "off";
      resetPerformance(c.issuedAtMs);
      const createdAt = performance.now();
      const next = new SimulationEngine(c.scenario, undefined, true, {
        profile,
      });
      workerPerformance.constructorMs = performance.now() - createdAt;
      engine = next;
      playing = c.playing;
      speed = c.speed;
      target = null;
      anchor();
      send(true);
      return;
    }
    if (!engine || c.runId !== runId) return;
    switch (c.type) {
      case "play":
        if (![1, 10, 60, 300].includes(c.speed))
          throw new Error("지원하지 않는 배속입니다.");
        if (engine.failure && c.playing)
          throw new Error(engine.failure.message);
        playing = c.playing;
        speed = c.speed;
        anchor();
        send(false, !playing);
        break;
      case "seek":
        if (
          !Number.isSafeInteger(c.atUs) ||
          c.atUs < 0 ||
          c.atUs > engine.scenario.durationUs
        )
          throw new Error("잘못된 탐색 시각입니다.");
        const scenario = engine.scenario;
        runId = c.nextRunId;
        engine = null;
        exportsPending.length = 0;
        pendingReset = true;
        pendingVerify = false;
        resetPerformance(c.issuedAtMs);
        const replayCreatedAt = performance.now();
        engine = new SimulationEngine(scenario, undefined, true, { profile });
        workerPerformance.constructorMs = performance.now() - replayCreatedAt;
        target = c.atUs;
        anchor();
        send(true);
        break;
      case "resync":
        send(true);
        break;
      case "step":
        playing = false;
        target = null;
        target = engine.nextEventUs();
        anchor();
        send(true);
        break;
      case "failure": {
        const event = {
          ...c.event,
          atUs: c.immediate ? engine.nowUs + 1 : c.event.atUs,
        };
        engine.addFailure(event);
        if (c.immediate) {
          target = event.atUs;
          anchor();
        }
        send();
        break;
      }
      case "finish":
        playing = false;
        target = engine.scenario.durationUs;
        send();
        break;
      case "export":
        exportsPending.push(c.what);
        break;
    }
  } catch (error) {
    fail(error, c.type === "load" || c.type === "seek" || !!engine?.failure);
  } finally {
    schedulePump(0);
  }
};
function exportReady() {
  if (!engine || engine.needsWork) return;
  for (const what of exportsPending.splice(0)) {
    port.postMessage({
      type: "export",
      runId,
      what: what,
      data:
        what === "scenario"
          ? structuredClone(engine.scenario)
          : {
              scenario: structuredClone(engine.scenario),
              ...(profile !== "off"
                ? { performance: performanceReport() }
                : {}),
              result: engine.result(),
              profiling: structuredClone(engine.profiling),
            },
    });
  }
}
function pump() {
  try {
    if (engine) {
      const now = performance.now();
      const until =
        target ??
        (playing
          ? Math.min(
              engine.scenario.durationUs,
              anchorUs +
                Math.max(0, Math.floor((now - anchorWall) * 1000 * speed)),
            )
          : engine.nowUs);
      if (target !== null || playing || engine.needsWork) {
        const sliceStarted = performance.now();
        const deadline = sliceStarted + (target !== null ? 12 : 6);
        let done: boolean;
        do {
          done = engine.advanceTo(Math.max(engine.nowUs, until), 128);
        } while (!done && performance.now() < deadline);
        if (profile !== "off") {
          const elapsed = performance.now() - sliceStarted;
          workerPerformance.activeMs += elapsed;
          workerPerformance.maxSliceMs = Math.max(
            workerPerformance.maxSliceMs,
            elapsed,
          );
          workerPerformance.pumps++;
        }
        if (done && target !== null) {
          target = null;
          anchor();
          send(true);
        }
        if (engine.nowUs === engine.scenario.durationUs) {
          playing = false;
          anchor();
          send(false, true);
        }
        if (now - lastSent >= 100 || busyReported) send();
      }
      exportReady();
    }
  } catch (error) {
    fail(error);
  }
  schedulePump(
    engine &&
      !engine.failure &&
      (target !== null || playing || engine.needsWork)
      ? 0
      : 100,
  );
}
pump();
