import { readFileSync } from "node:fs";
import { SimulationEngine } from "../src/engine.ts";
const file = process.argv[2];
if (!file) throw new Error("Usage: npm run simulate -- scenario.json");
const engine = new SimulationEngine(
  JSON.parse(readFileSync(file, "utf8")),
  undefined,
  true,
  { render: false },
);
while (!engine.advanceTo(engine.scenario.durationUs, 500)) engine.drainDeltas();
engine.drainDeltas();
console.log(
  JSON.stringify(
    {
      scenario: engine.scenario,
      result: engine.result(),
      profiling: engine.profiling,
    },
    null,
    2,
  ),
);
