import type { McsrView } from "./mcsr";
import type { ControlFlight, ControlView } from "./controlTransport";
export interface McsrDelta {
  domains: McsrView["domains"];
  events: McsrView["events"];
  control?: Omit<ControlView, "flights"> & {
    changedFlights: ControlFlight[];
    removedFlights: number[];
  };
}
function sameFlight(a: ControlFlight, b: ControlFlight | undefined) {
  return (
    !!b &&
    a.origin === b.origin &&
    a.recipient === b.recipient &&
    a.kind === b.kind &&
    a.revision === b.revision &&
    a.attempt === b.attempt &&
    a.hop === b.hop &&
    a.departedUs === b.departedUs &&
    a.arrivesUs === b.arrivesUs &&
    a.expiresUs === b.expiresUs &&
    (a.path === b.path ||
      (a.path.length === b.path.length &&
        a.path.every((n, i) => n === b.path[i])))
  );
}
export function diffMcsr(previous: McsrView, next: McsrView): McsrDelta {
  const domains = next.domains.filter((d, i) => d !== previous.domains[i]);
  const before = new Map(
    previous.control?.flights.map((f) => [f.messageId, f]) ?? [],
  );
  const after = new Map(
    next.control?.flights.map((f) => [f.messageId, f]) ?? [],
  );
  const { flights, ...control } = next.control ?? { flights: [] };
  return {
    domains,
    events: next.events,
    ...(next.control
      ? {
          control: {
            ...(control as Omit<ControlView, "flights">),
            changedFlights: flights.filter(
              (f) => !sameFlight(f, before.get(f.messageId)),
            ),
            removedFlights: [...before.keys()].filter((id) => !after.has(id)),
          },
        }
      : {}),
  };
}
export function applyMcsr(
  previous: McsrView | undefined,
  delta: McsrDelta,
): McsrView {
  if (!previous) throw new Error("MCSR 체크포인트가 없습니다.");
  const domains = [...previous.domains];
  for (const domain of delta.domains) {
    if (
      !domains[domain.id] ||
      domain.receivedVersions.length !== domains.length
    )
      throw new Error("잘못된 CSIB 변경분입니다.");
    domains[domain.id] = domain;
  }
  let control = previous.control;
  if (delta.control) {
    if (!control) throw new Error("제어 통신 체크포인트가 없습니다.");
    const flights = new Map(control.flights.map((f) => [f.messageId, f]));
    for (const id of delta.control.removedFlights) flights.delete(id);
    for (const f of delta.control.changedFlights) flights.set(f.messageId, f);
    const { changedFlights, removedFlights, ...state } = delta.control;
    control = { ...control, ...state, flights: [...flights.values()] };
  }
  return {
    ...previous,
    domains,
    events: delta.events,
    ...(control ? { control } : {}),
  };
}
