import { SimulationEngine } from "./engine";
import type { Command, Reply } from "./protocol";
const port = self as unknown as {
  onmessage: ((e: MessageEvent<Command>) => void) | null;
  postMessage: (reply: Reply) => void;
};
let engine: SimulationEngine | null = null,
  runId = 0,
  playing = false,
  speed = 10,
  target: number | null = null,
  anchorWall = 0,
  anchorUs = 0,
  lastSent = -Infinity;
function anchor() {
  anchorWall = performance.now();
  anchorUs = engine?.nowUs ?? 0;
}
function send() {
  if (engine) {
    port.postMessage({
      type: "state",
      runId,
      frame: engine.snapshot(),
      busy: target !== null,
      playing,
    });
    lastSent = performance.now();
  }
}
function fail(error: unknown, stop = true) {
  if (stop) {
    playing = false;
    target = null;
  }
  port.postMessage({
    type: "error",
    runId,
    message: error instanceof Error ? error.message : String(error),
  });
}
port.onmessage = ({ data: c }) => {
  try {
    if (c.type === "load") {
      runId = c.runId;
      const next = new SimulationEngine(c.scenario);
      engine = next;
      playing = c.playing;
      speed = c.speed;
      target = null;
      anchor();
      send();
      return;
    }
    if (!engine || c.runId !== runId) return;
    switch (c.type) {
      case "play":
        if (![1, 10, 60, 300].includes(c.speed))
          throw new Error("지원하지 않는 배속입니다.");
        playing = c.playing;
        speed = c.speed;
        anchor();
        send();
        break;
      case "seek":
        if (
          !Number.isSafeInteger(c.atUs) ||
          c.atUs < 0 ||
          c.atUs > engine.scenario.durationUs
        )
          throw new Error("잘못된 탐색 시각입니다.");
        engine = new SimulationEngine(engine.scenario);
        runId = c.nextRunId;
        target = c.atUs;
        anchor();
        send();
        break;
      case "step":
        playing = false;
        target = null;
        engine.step();
        anchor();
        send();
        break;
      case "failure": {
        const event = {
          ...c.event,
          atUs: c.immediate ? engine.nowUs + 1 : c.event.atUs,
        };
        engine.addFailure(event);
        if (c.immediate) {
          engine.advanceTo(event.atUs);
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
        port.postMessage({
          type: "export",
          runId,
          what: c.what,
          data:
            c.what === "scenario"
              ? structuredClone(engine.scenario)
              : {
                  scenario: structuredClone(engine.scenario),
                  result: engine.result(),
                  profiling: structuredClone(engine.profiling),
                },
        });
        break;
    }
  } catch (error) {
    fail(error, false);
  }
};
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
      if (target !== null || playing) {
        const done = engine.advanceTo(Math.max(engine.nowUs, until), 500);
        if (done && target !== null) {
          target = null;
          anchor();
          send();
        }
        if (engine.nowUs === engine.scenario.durationUs) {
          playing = false;
          anchor();
          send();
        }
        if (now - lastSent >= 100) send();
      }
    }
  } catch (error) {
    fail(error);
  }
  setTimeout(pump, 8);
}
pump();
