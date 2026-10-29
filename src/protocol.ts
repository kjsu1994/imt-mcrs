import type {
  Scenario,
  FailureEvent,
  RenderCheckpoint,
  TopologyDelta,
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
  | { type: "resync"; runId: number }
  | { type: "step"; runId: number }
  | { type: "failure"; runId: number; event: FailureEvent; immediate?: boolean }
  | { type: "finish"; runId: number }
  | { type: "export"; runId: number; what: "scenario" | "result" };
export type Reply =
  | { type: "busy"; runId: number }
  | {
      type: "state";
      runId: number;
      progress: Omit<
        ReturnType<SimulationEngine["progress"]>,
        "serviceOutages" | "linkFailures" | "mcsr"
      >;
      histories?: Pick<
        ReturnType<SimulationEngine["progress"]>,
        "serviceOutages" | "linkFailures"
      >;
      scenario?: Scenario;
      deltas: TopologyDelta[];
      checkpoint?: RenderCheckpoint;
      reset: boolean;
      busy: boolean;
      playing: boolean;
    }
  | { type: "error"; runId: number; message: string; fatal?: boolean }
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
