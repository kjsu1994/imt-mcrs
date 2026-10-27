import { useEffect, useRef, useState } from "react";
import type { Scenario, FailureEvent, SimulationFrame } from "./engine";
import type { Command, Reply } from "./protocol";
export function useSimulation(
  scenario: Scenario,
  playing: boolean,
  speed: number,
) {
  const worker = useRef<Worker | null>(null),
    id = useRef(0);
  const [state, setState] = useState<{
      owner: Scenario;
      frame: SimulationFrame;
      busy: boolean;
      playing: boolean;
    } | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    const w = new Worker(new URL("./simulation.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.current = w;
    const runId = ++id.current;
    let active = true;
    setError("");
    w.onmessage = ({ data }: MessageEvent<Reply>) => {
      if (!active || data.runId !== id.current) return;
      if (data.type === "error") setError(data.message);
      else if (data.type === "state")
        setState({
          owner: scenario,
          frame: data.frame,
          busy: data.busy,
          playing: data.playing,
        });
      else {
        const url = URL.createObjectURL(
            new Blob([JSON.stringify(data.data, null, 2)], {
              type: "application/json",
            }),
          ),
          a = document.createElement("a");
        a.href = url;
        a.download = `mcsr-${data.what}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    };
    w.onerror = (e) => {
      if (active) setError(`시뮬레이션 Worker 오류: ${e.message}`);
    };
    w.postMessage({
      type: "load",
      runId,
      scenario,
      playing,
      speed,
    } satisfies Command);
    return () => {
      active = false;
      worker.current = null;
      w.terminate();
    };
  }, [scenario]);
  useEffect(() => {
    worker.current?.postMessage({
      type: "play",
      runId: id.current,
      playing,
      speed,
    } satisfies Command);
  }, [playing, speed, scenario]);
  function send(command: Command) {
    worker.current?.postMessage(command);
  }
  return {
    frame: state?.owner === scenario ? state.frame : null,
    runId: id.current,
    running: state?.owner === scenario && state.playing && !state.busy && playing,
    busy: state?.owner !== scenario || state.busy,
    ended:
      state?.owner === scenario && state.frame.timeUs === scenario.durationUs,
    error,
    clearError: () => setError(""),
    seek: (atUs: number) => {
      const runId = id.current;
      const nextRunId = ++id.current;
      setState((s) => (s ? { ...s, busy: true } : s));
      send({ type: "seek", runId, nextRunId, atUs });
    },
    step: () => send({ type: "step", runId: id.current }),
    finish: () => send({ type: "finish", runId: id.current }),
    failure: (event: FailureEvent, immediate = false) =>
      send({ type: "failure", runId: id.current, event, immediate }),
    exportData: (what: "scenario" | "result") =>
      send({ type: "export", runId: id.current, what }),
  };
}
