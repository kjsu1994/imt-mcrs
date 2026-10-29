import type { GroundRole } from "./ground";
// Preserve v9 scenario keys while presenting the source as GS and destination as UT.
export const groundLabel = (role: GroundRole) => (role === "ut" ? "GS" : "UT");
