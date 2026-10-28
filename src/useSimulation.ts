import { useEffect, useRef, useState } from "react";
import type { Scenario, FailureEvent, SimulationFrame } from "./engine";
import type { Command, Reply } from "./protocol";
import { TopologyStream } from "./topologyStream";
export function useSimulation(
  scenario: Scenario,
  playing: boolean,
  speed: number,
) {
  const worker = useRef<Worker | null>(null),
    id = useRef(0),
    topology = useRef(new TopologyStream());
  const [state, setState] = useState<{
      owner: Scenario;
      frame: SimulationFrame;
      busy: boolean;
      playing: boolean;
    } | null>(null),
    [error, setError] = useState(""),
    [failed, setFailed] = useState(false);
  useEffect(() => {
    const w = new Worker(new URL("./simulation.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.current = w;
    const runId = ++id.current;
    let active = true,
      syncing = false;
    const stream = new TopologyStream();
    topology.current = stream;
    let currentScenario = scenario;
    let histories: Pick<SimulationFrame, "serviceOutages" | "linkFailures"> = {
      serviceOutages: [],
      linkFailures: [],
    };
    setError("");
    setFailed(false);
    w.onmessage = ({ data }: MessageEvent<Reply>) => {
      if (!active || data.runId !== id.current) return;
      if (data.type === "error") {
        setError(data.message);
        if (data.fatal) setFailed(true);
      } else if (data.type === "state") {
        if (syncing && !data.reset) return;
        try {
          if (data.reset) {
            if (!data.checkpoint) throw new Error("재동기화 상태가 없습니다.");
            stream.reset(data.checkpoint);
            setFailed(!!data.progress.failure);
            if (!data.progress.failure) setError("");
            syncing = false;
          } else {
            stream.receive(data.deltas);
            if (stream.pendingCount > 8192)
              throw new Error("표시 버퍼 재동기화가 필요합니다.");
            if (data.checkpoint && !stream.matches(data.checkpoint))
              throw new Error("전체 상태와 변경분이 일치하지 않습니다.");
          }
          if (data.scenario) currentScenario = data.scenario;
          if (data.histories) histories = data.histories;
          setState({
            owner: scenario,
            frame: {
              ...data.progress,
              ...histories,
              scenario: currentScenario,
            },
            busy: data.busy,
            playing: data.playing,
          });
        } catch (error) {
          if (data.reset) {
            setError(
              error instanceof Error
                ? error.message
                : "토폴로지 재동기화에 실패했습니다.",
            );
            return;
          }
          syncing = true;
          setState((s) => (s ? { ...s, busy: true } : s));
          w.postMessage({
            type: "resync",
            runId: id.current,
          } satisfies Command);
        }
      } else {
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
    topology: topology.current,
    frame: state?.owner === scenario ? state.frame : null,
    runId: id.current,
    running:
      !failed &&
      state?.owner === scenario &&
      state.playing &&
      !state.busy &&
      playing,
    failed,
    busy: !failed && (state?.owner !== scenario || state.busy),
    ended:
      !failed &&
      state?.owner === scenario &&
      state.frame.timeUs === scenario.durationUs,
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
