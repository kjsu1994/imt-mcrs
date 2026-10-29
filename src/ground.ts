import { EARTH_RADIUS, distance } from "./model";
import type { Vec3 } from "./model";

export type GroundPoint = { latitude: number; longitude: number };
export type GroundSettings = {
  ut: GroundPoint | null;
  gs: GroundPoint | null;
  minimumElevationDeg: number;
  handoverDelayUs: number;
};
export type GroundRole = "ut" | "gs";
export type GroundAttachment = {
  point: GroundPoint | null;
  satelliteId: number | null;
  elevationDeg: number | null;
  distanceM: number | null;
  readyAtUs: number | null;
  ready: boolean;
};
export type GroundView = {
  ut: GroundAttachment;
  gs: GroundAttachment;
  routePending: boolean;
  available: boolean;
};
export type GroundReason = "access" | "handover" | "isl";
export const defaultGround = (): GroundSettings => ({
  ut: null,
  gs: null,
  minimumElevationDeg: 10,
  handoverDelayUs: 100000,
});
export function validateGround(settings: GroundSettings | null) {
  if (settings === null) return;
  if (!settings || typeof settings !== "object")
    throw new Error("잘못된 지상 접속 설정입니다.");
  for (const role of ["ut", "gs"] as const) {
    const point = settings[role];
    if (point === null) continue;
    if (
      !point ||
      !Number.isFinite(point.latitude) ||
      Math.abs(point.latitude) > 90 ||
      !Number.isFinite(point.longitude) ||
      Math.abs(point.longitude) > 180
    )
      throw new Error("지상 좌표는 위도 -90~90°, 경도 -180~180°여야 합니다.");
  }
  if (
    !Number.isFinite(settings.minimumElevationDeg) ||
    settings.minimumElevationDeg < 0 ||
    settings.minimumElevationDeg > 90
  )
    throw new Error("최소 고각은 0~90°여야 합니다.");
  if (
    !Number.isSafeInteger(settings.handoverDelayUs) ||
    settings.handoverDelayUs < 0 ||
    settings.handoverDelayUs > 60000000
  )
    throw new Error("핸드오버 지연은 0~60초여야 합니다.");
}
// Use the same spherical surface as the orbital/occlusion model; Cesium maps latitude/longitude to its display ellipsoid.
export function groundPosition(point: GroundPoint): Vec3 {
  const lat = (point.latitude * Math.PI) / 180,
    lon = (point.longitude * Math.PI) / 180;
  return {
    x: EARTH_RADIUS * Math.cos(lat) * Math.cos(lon),
    y: EARTH_RADIUS * Math.cos(lat) * Math.sin(lon),
    z: EARTH_RADIUS * Math.sin(lat),
  };
}
export function elevationDeg(point: GroundPoint, satellite: Vec3) {
  const g = groundPosition(point),
    range = distance(g, satellite);
  if (range === 0) return -90;
  const cosine =
    ((satellite.x - g.x) * g.x +
      (satellite.y - g.y) * g.y +
      (satellite.z - g.z) * g.z) /
    (EARTH_RADIUS * range);
  return (
    Math.round(
      ((Math.asin(Math.max(-1, Math.min(1, cosine))) * 180) / Math.PI) * 1e9,
    ) / 1e9
  );
}
export type AccessEvent = {
  atUs: number;
  role: GroundRole;
  from: number | null;
  to: number | null;
  readyAtUs: number | null;
  kind: "initial" | "acquisition" | "handover" | "lost";
};
export class GroundAccess {
  readonly events: AccessEvent[] = [];
  private attachments: Record<
    GroundRole,
    { id: number | null; readyAtUs: number | null }
  > = {
    ut: { id: null, readyAtUs: null },
    gs: { id: null, readyAtUs: null },
  };
  constructor(readonly settings: GroundSettings) {
    validateGround(settings);
  }
  update(p: Vec3[], atUs: number) {
    let changed = false;
    for (const role of ["ut", "gs"] as const) {
      const point = this.settings[role],
        previous = this.attachments[role];
      let id = previous.id;
      if (!point) id = null;
      else if (
        id === null ||
        elevationDeg(point, p[id]) < this.settings.minimumElevationDeg
      ) {
        id = null;
        let best = -Infinity;
        for (let i = 0; i < p.length; i++) {
          const elevation = elevationDeg(point, p[i]);
          if (
            elevation >= this.settings.minimumElevationDeg &&
            elevation > best + 1e-10
          ) {
            best = elevation;
            id = i;
          }
        }
      }
      if (id === previous.id) continue;
      const readyAtUs =
        id === null
          ? null
          : atUs + (atUs === 0 ? 0 : this.settings.handoverDelayUs);
      this.attachments[role] = { id, readyAtUs };
      this.events.push({
        atUs,
        role,
        from: previous.id,
        to: id,
        readyAtUs,
        kind:
          id === null
            ? "lost"
            : atUs === 0
              ? "initial"
              : previous.id === null
                ? "acquisition"
                : "handover",
      });
      changed = true;
    }
    return changed;
  }
  view(
    p: Vec3[],
    atUs: number,
    routePending: boolean,
    pathValid: boolean,
  ): GroundView {
    const attachment = (role: GroundRole): GroundAttachment => {
      const { id, readyAtUs } = this.attachments[role],
        point = this.settings[role];
      return {
        point,
        satelliteId: id,
        readyAtUs,
        ready: readyAtUs !== null && atUs >= readyAtUs,
        elevationDeg: point && id !== null ? elevationDeg(point, p[id]) : null,
        distanceM:
          point && id !== null
            ? Math.round(distance(groundPosition(point), p[id]) * 1000) / 1000
            : null,
      };
    };
    const ut = attachment("ut"),
      gs = attachment("gs");
    return {
      ut,
      gs,
      routePending,
      available: ut.ready && gs.ready && !routePending && pathValid,
    };
  }
  get source() {
    return this.attachments.ut.id;
  }
  get target() {
    return this.attachments.gs.id;
  }
  ready(atUs: number) {
    return [this.attachments.ut, this.attachments.gs].every(
      (a) => a.readyAtUs !== null && a.readyAtUs <= atUs,
    );
  }
  get readyTimesUs() {
    return [
      ...new Set(
        [this.attachments.ut.readyAtUs, this.attachments.gs.readyAtUs].filter(
          (t): t is number => t !== null,
        ),
      ),
    ];
  }
  readinessKey(atUs: number) {
    return [this.attachments.ut, this.attachments.gs]
      .map((a) => a.readyAtUs !== null && a.readyAtUs <= atUs)
      .join(":");
  }
}

type GroundInterval = {
  startedUs: number;
  endedUs: number | null;
  reason: GroundReason;
};
type GroundOutage = {
  startedUs: number;
  recoveredUs: number | null;
  causes: GroundReason[];
};
export class GroundMetrics {
  readonly intervals: GroundInterval[] = [];
  readonly outages: GroundOutage[] = [];
  observe(atUs: number, view: GroundView) {
    const reason: GroundReason | null = view.available
      ? null
      : view.ut.satelliteId === null || view.gs.satelliteId === null
        ? "access"
        : !view.ut.ready || !view.gs.ready || view.routePending
          ? "handover"
          : "isl";
    const interval = this.intervals.at(-1);
    if (interval?.endedUs === null && interval.reason !== reason)
      interval.endedUs = atUs;
    if (
      reason &&
      (!interval || interval.endedUs !== null || interval.reason !== reason)
    )
      this.intervals.push({ startedUs: atUs, endedUs: null, reason });
    const outage = this.outages.at(-1);
    if (!reason) {
      if (outage?.recoveredUs === null) outage.recoveredUs = atUs;
    } else if (!outage || outage.recoveredUs !== null)
      this.outages.push({
        startedUs: atUs,
        recoveredUs: null,
        causes: [reason],
      });
    else if (!outage.causes.includes(reason)) outage.causes.push(reason);
  }
  summary(atUs: number, limit = Infinity) {
    const downtime = { access: 0, handover: 0, isl: 0 };
    for (const interval of this.intervals)
      downtime[interval.reason] += Math.max(
        0,
        (interval.endedUs ?? atUs) - interval.startedUs,
      );
    const totalDowntimeUs = downtime.access + downtime.handover + downtime.isl;
    return {
      availability: atUs === 0 ? null : 1 - totalDowntimeUs / atUs,
      totalDowntimeUs,
      accessDowntimeUs: downtime.access,
      handoverDowntimeUs: downtime.handover,
      islDowntimeUs: downtime.isl,
      outageCount: this.outages.filter((o) => o.startedUs < atUs).length,
      outages: structuredClone(
        this.outages.slice(limit === Infinity ? 0 : -limit),
      ),
    };
  }
  result(atUs: number) {
    return {
      ...this.summary(atUs),
      intervals: structuredClone(this.intervals),
    };
  }
}
