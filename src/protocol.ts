import type {
  Scenario,
  FailureEvent,
  SimulationFrame,
  SimulationEngine,
} from "./engine";
export type Command =
  | {
      type: "load";
      runId: number;
      scenario: Scenario;
      playing: boolean;
      speed: number;
    }
  | { type: "play"; runId: number; playing: boolean; speed: number }
  | { type: "seek"; runId: number; nextRunId: number; atUs: number }
  | { type: "step"; runId: number }
  | { type: "failure"; runId: number; event: FailureEvent; immediate?: boolean }
  | { type: "finish"; runId: number }
  | { type: "export"; runId: number; what: "scenario" | "result" };
export type Reply =
  | {
      type: "state";
      runId: number;
      frame: SimulationFrame;
      busy: boolean;
      playing: boolean;
    }
  | { type: "error"; runId: number; message: string }
  | {
      type: "export";
      runId: number;
      what: "scenario" | "result";
      data:
        | Scenario
        | {
            scenario: Scenario;
            result: ReturnType<SimulationEngine["result"]>;
            profiling: { atUs: number; wallMs: number }[];
          };
    };
