import type { GroundSettings, GroundPoint, GroundRole } from "./ground";
import { useEffect, useRef, useState } from "react";
import {
  Viewer,
  BillboardCollection,
  LabelCollection,
  DistanceDisplayCondition,
  NearFarScalar,
  SingleTileImageryProvider,
  Rectangle,
  Cartesian2,
  Cartesian3,
  Color,
  PointPrimitiveCollection,
  PolylineCollection,
  JulianDate,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  Math as CMath,
  Cartographic,
  HeadingPitchRange,
  Matrix4,
  Credit,
  EllipsoidTerrainProvider,
  Transforms,
} from "cesium";
import {
  EARTH_RADIUS,
  positions,
  inertial,
  fixed,
  gmst,
  period,
} from "./model";
import type { Config, Vec3 } from "./model";
import type { SimulationFrame, RenderCheckpoint } from "./engine";
import type { TopologyStream } from "./topologyStream";
import { DisplayClock } from "./displayClock";
export type Telemetry = {
  latitude: number;
  longitude: number;
  altitude: number;
};
type Props = {
  config: Config;
  startMs: number;
  frame: SimulationFrame | null;
  topology: TopologyStream;
  runId: number;
  running: boolean;
  selectedLink: string;
  previewPath: number[];
  selected: number | null;
  source: number;
  target: number;
  links: boolean;
  allOrbits: boolean;
  showSrds: boolean;
  showControl: boolean;
  controlPath: number[];
  tracking: boolean;
  home: number;
  groundSettings: GroundSettings | null;
  onGroundPick: (role: GroundRole, point: GroundPoint) => void;
  onPick: (id: number) => void;
  onTelemetry: (s: Telemetry) => void;
  onPickLink: (id: string) => void;
  onError: (s: string) => void;
};
const palette = [
  "#64d9ed",
  "#b6a2ff",
  "#f5bd75",
  "#73d5b0",
  "#f68ca8",
  "#a0bfff",
];
const cart = (p: Vec3) => new Cartesian3(p.x, p.y, p.z);
export default function Globe(props: Props) {
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    point: GroundPoint;
  } | null>(null);
  const menuElement = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    const outside = (e: PointerEvent) => {
      if (!menuElement.current?.contains(e.target as Node)) setMenu(null);
    };
    document.addEventListener("keydown", key);
    document.addEventListener("pointerdown", outside);
    menuElement.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      document.removeEventListener("keydown", key);
      document.removeEventListener("pointerdown", outside);
    };
  }, [menu]);
  const container = useRef<HTMLDivElement>(null),
    current = useRef(props);
  current.current = props;
  useEffect(() => {
    let viewer: Viewer | undefined,
      handler: ScreenSpaceEventHandler | undefined,
      disposed = false,
      releaseRotation = () => {};
    try {
      viewer = new Viewer(container.current!, {
        baseLayer: false,
        terrainProvider: new EllipsoidTerrainProvider(),
        animation: false,
        timeline: false,
        baseLayerPicker: false,
        geocoder: false,
        homeButton: false,
        sceneModePicker: false,
        navigationHelpButton: false,
        fullscreenButton: false,
        selectionIndicator: false,
        infoBox: false,
        shouldAnimate: false,
        skyBox: false,
      });
      viewer.scene.backgroundColor = Color.fromCssColorString("#070c16");
      viewer.scene.globe.baseColor = Color.fromCssColorString("#163346");
      viewer.scene.globe.enableLighting = false;
      viewer.scene.globe.showGroundAtmosphere = false;
      viewer.resolutionScale = Math.min(window.devicePixelRatio || 1, 1.5);
      const controller = viewer.scene.screenSpaceCameraController;
      viewer.camera.constrainedAxis = undefined;
      controller.enableTranslate = false;
      controller.enableRotate = false;
      controller.enableTilt = false;
      controller.enableLook = false;
      const earthFrame = Transforms.eastNorthUpToFixedFrame(Cartesian3.ZERO);
      const centerOnEarth = () => {
        const camera = viewer!.camera;
        // Keep the world position while switching from satellite tracking to an Earth-centered orbit.
        camera.lookAtTransform(earthFrame);
        camera.lookAtTransform(earthFrame, Cartesian3.clone(camera.position));
      };
      const start = JulianDate.fromDate(new Date(props.startMs));
      viewer.clock.startTime = start.clone();
      viewer.clock.currentTime = start.clone();
      viewer.clock.shouldAnimate = false;
      void SingleTileImageryProvider.fromUrl(
        `${import.meta.env.BASE_URL}textures/earth.jpg`,
        {
          rectangle: Rectangle.MAX_VALUE,
          credit: new Credit(
            "Natural Earth III / Tom Patterson / public domain",
          ),
        },
      )
        .then((provider) => {
          if (!disposed) viewer!.imageryLayers.addImageryProvider(provider);
        })
        .catch(() => {
          if (!disposed)
            current.current.onError(
              "로컬 지구 텍스처를 불러오지 못했습니다. public/textures/earth.jpg를 확인하세요.",
            );
        });
      const points = viewer.scene.primitives.add(
        new PointPrimitiveCollection(),
      ) as PointPrimitiveCollection;
      const satelliteIcons = viewer.scene.primitives.add(
        new BillboardCollection(),
      ) as BillboardCollection;
      const dsLabels = viewer.scene.primitives.add(
        new LabelCollection(),
      ) as LabelCollection;
      const iconDistance = 5000000;
      const groundIcons = viewer.scene.primitives.add(
        new BillboardCollection(),
      ) as BillboardCollection;
      const groundLabels = viewer.scene.primitives.add(
        new LabelCollection(),
      ) as LabelCollection;
      const groundLinks = viewer.scene.primitives.add(
        new PolylineCollection(),
      ) as PolylineCollection;
      for (const role of ["ut", "gs"] as const) {
        groundIcons.add({
          id: `ground:${role}`,
          position: Cartesian3.ZERO,
          show: false,
          image: `${import.meta.env.BASE_URL}textures/ground-${role}.svg`,
          width: 30,
          height: 30,
        });
        groundLabels.add({
          position: Cartesian3.ZERO,
          show: false,
          text: role.toUpperCase(),
          font: "bold 13px sans-serif",
          fillColor: Color.fromCssColorString(
            role === "ut" ? "#80efbb" : "#ffbb78",
          ),
          pixelOffset: new Cartesian2(0, -26),
          showBackground: true,
          backgroundColor: Color.fromCssColorString("#101827").withAlpha(0.9),
        });
        groundLinks.add({
          positions: [Cartesian3.ZERO, Cartesian3.ZERO],
          show: false,
          width: 3,
        });
      }
      const packets = viewer.scene.primitives.add(
        new PointPrimitiveCollection(),
      ) as PointPrimitiveCollection;
      const controlPoints = viewer.scene.primitives.add(
        new PointPrimitiveCollection(),
      ) as PointPrimitiveCollection;
      const controlLines = viewer.scene.primitives.add(
        new PolylineCollection(),
      ) as PolylineCollection;
      let controlPathKey = "";
      // Small collections avoid Cesium scanning thousands of earlier lines for every position update.
      const wireGroups: PolylineCollection[] = [];
      const linesPerGroup = 128;
      const paths = viewer.scene.primitives.add(
        new PolylineCollection(),
      ) as PolylineCollection;
      const previewLines = viewer.scene.primitives.add(
        new PolylineCollection(),
      ) as PolylineCollection;
      let previewKey = "",
        lastLinkStyle = "";
      const orbits = viewer.scene.primitives.add(
        new PolylineCollection(),
      ) as PolylineCollection;
      let config: Config | null = null,
        wireIds: [number, number][] = [],
        lastSelected: number | null | undefined,
        lastAll: boolean | undefined,
        lastHome = -1,
        routeKey = "",
        linkKey = "",
        orbitBucket = -1,
        lastReport = 0,
        lastStyle = "",
        lastSelectedLink = "",
        lastFrame: RenderCheckpoint | null = null,
        lastGeneration = -1,
        lastTrack = false,
        lastRunId = -1,
        lastClockFrame: SimulationFrame | null = null,
        lastRunning = false,
        dragging = false;
      const displayClock = new DisplayClock();
      handler = new ScreenSpaceEventHandler(viewer.scene.canvas);
      handler.setInputAction((event: { position: Cartesian2 }) => {
        const picked = viewer!.scene.pick(event.position);
        if (picked && typeof picked.id === "number")
          current.current.onPick(picked.id);
        else if (
          picked &&
          typeof picked.id === "string" &&
          picked.id.startsWith("isl:")
        )
          current.current.onPickLink(picked.id.slice(4));
      }, ScreenSpaceEventType.LEFT_CLICK);
      handler.setInputAction((event: { position: Cartesian2 }) => {
        const ray = viewer!.camera.getPickRay(event.position);
        const surface = ray
          ? viewer!.scene.globe.pick(ray, viewer!.scene)
          : undefined;
        if (!surface) {
          setMenu(null);
          return;
        }
        const coordinate = Cartographic.fromCartesian(surface);
        setMenu({
          x: Math.max(
            8,
            Math.min(event.position.x, viewer!.scene.canvas.clientWidth - 238),
          ),
          y: Math.max(
            8,
            Math.min(event.position.y, viewer!.scene.canvas.clientHeight - 168),
          ),
          point: {
            latitude: CMath.toDegrees(coordinate.latitude),
            longitude: CMath.toDegrees(coordinate.longitude),
          },
        });
      }, ScreenSpaceEventType.RIGHT_CLICK);
      handler.setInputAction(() => {
        setMenu(null);
        dragging = true;
      }, ScreenSpaceEventType.LEFT_DOWN);
      handler.setInputAction(() => {
        dragging = false;
      }, ScreenSpaceEventType.LEFT_UP);
      const releaseDrag = () => {
        dragging = false;
      };
      window.addEventListener("pointerup", releaseDrag);
      window.addEventListener("blur", releaseDrag);
      releaseRotation = () => {
        window.removeEventListener("pointerup", releaseDrag);
        window.removeEventListener("blur", releaseDrag);
      };
      handler.setInputAction(
        (movement: { startPosition: Cartesian2; endPosition: Cartesian2 }) => {
          if (!dragging || current.current.tracking) return;
          const camera = viewer!.camera,
            canvas = viewer!.scene.canvas;
          const altitude = Math.max(
            0,
            Cartesian3.magnitude(camera.positionWC) - EARTH_RADIUS,
          );
          const sensitivity = Math.min(1, Math.max(0.01, altitude / 21000000));
          camera.rotateRight(
            ((movement.startPosition.x - movement.endPosition.x) /
              canvas.clientWidth) *
              Math.PI *
              2 *
              1.77 *
              sensitivity,
          );
          camera.rotateUp(
            ((movement.startPosition.y - movement.endPosition.y) /
              canvas.clientHeight) *
              Math.PI *
              1.77 *
              sensitivity,
          );
        },
        ScreenSpaceEventType.MOUSE_MOVE,
      );
      const update = () => {
        if (!viewer || viewer.isDestroyed()) return;
        const p = current.current,
          now = performance.now();
        if (
          lastClockFrame !== p.frame ||
          lastRunId !== p.runId ||
          lastRunning !== p.running ||
          lastGeneration !== p.topology.generation
        ) {
          displayClock.receive(
            p.frame?.timeUs ?? 0,
            now,
            p.running &&
              lastRunning &&
              lastRunId === p.runId &&
              lastClockFrame !== null &&
              lastGeneration === p.topology.generation,
          );
          lastGeneration = p.topology.generation;
          lastClockFrame = p.frame;
          lastRunId = p.runId;
          lastRunning = p.running;
        }
        const seconds = displayClock.at(now) / 1000000;
        viewer.clock.shouldAnimate = false;
        viewer.clock.currentTime = JulianDate.addSeconds(
          start,
          seconds,
          new JulianDate(),
        );
        const display = p.frame ? p.topology.at(displayClock.at(now)) : null;
        const path = display?.path ?? [];
        const ground = display?.ground;
        const source = ground ? ground.ut.satelliteId : p.source;
        const target = ground ? ground.gs.satelliteId : p.target;
        if (config !== p.config) {
          config = p.config;
          points.removeAll();
          satelliteIcons.removeAll();
          dsLabels.removeAll();
          packets.removeAll();
          controlPoints.removeAll();
          controlLines.removeAll();
          controlPathKey = "";
          wireGroups.forEach((group) => group.removeAll());
          paths.removeAll();
          previewLines.removeAll();
          previewKey = "";
          orbits.removeAll();
          for (let id = 0; id < config.planes * config.perPlane; id++) {
            satelliteIcons.add({
              id,
              position: Cartesian3.ZERO,
              image: `${import.meta.env.BASE_URL}textures/satellite-node.png`,
              width: 64,
              height: 64,
              distanceDisplayCondition: new DistanceDisplayCondition(
                0,
                iconDistance,
              ),
              scaleByDistance: new NearFarScalar(100000, 1, iconDistance, 0.5),
            });
            points.add({
              id,
              position: Cartesian3.ZERO,
              pixelSize: 5,
              color: Color.fromCssColorString(
                palette[Math.floor(id / config.perPlane) % palette.length],
              ),
              outlineColor: Color.BLACK,
              outlineWidth: 1,
              distanceDisplayCondition: new DistanceDisplayCondition(
                iconDistance,
                Number.MAX_VALUE,
              ),
            });
          }
          for (let i = 0; i < 9; i++)
            packets.add({
              position: Cartesian3.ZERO,
              pixelSize: 6,
              color: Color.fromCssColorString("#fff0a6"),
              outlineWidth: 1,
              outlineColor: Color.fromCssColorString("#e8aa32"),
              show: false,
            });
          lastFrame = null;
          lastStyle = "";
          routeKey = "";
          linkKey = "";
          wireIds = [];
          lastSelected = undefined;
          orbitBucket = -1;
        }
        const pos = positions(p.config, seconds, p.startMs);
        const scenePositions = pos.map(cart);
        const groundPositions: Partial<Record<GroundRole, Cartesian3>> = {};
        for (const [i, role] of (["ut", "gs"] as const).entries()) {
          const point = p.groundSettings?.[role],
            attachment = ground?.[role];
          const icon = groundIcons.get(i),
            label = groundLabels.get(i),
            line = groundLinks.get(i);
          icon.show = label.show = !!point;
          line.show = !!point && attachment?.satelliteId != null;
          if (!point) continue;
          // A small display offset keeps the marker above the ellipsoid; simulation ground altitude remains zero.
          const at = Cartesian3.fromDegrees(
            point.longitude,
            point.latitude,
            500,
          );
          groundPositions[role] = at;
          icon.position = label.position = at;
          if (line.show && attachment?.satelliteId != null) {
            line.positions = [at, scenePositions[attachment.satelliteId]];
            line.material.uniforms.color = Color.fromCssColorString(
              !attachment.ready
                ? "#ff7a82"
                : role === "ut"
                  ? "#80efbb"
                  : "#ffbb78",
            );
          }
        }
        const iconView =
          Cartesian3.magnitude(viewer.camera.positionWC) <
          EARTH_RADIUS + p.config.altitude * 1000 + iconDistance;
        satelliteIcons.show = iconView;
        const srd = p.showSrds ? display?.mcsr : undefined;
        if (dsLabels.length !== (srd?.domains.length ?? 0)) {
          dsLabels.removeAll();
          for (const domain of srd?.domains ?? [])
            dsLabels.add({
              position: Cartesian3.ZERO,
              text: `DS · S${domain.id}`,
              font: "12px sans-serif",
              fillColor: Color.WHITE,
              showBackground: true,
              backgroundColor:
                Color.fromCssColorString("#101827").withAlpha(0.85),
              pixelOffset: new Cartesian2(0, -30),
            });
        }
        for (let i = 0; i < dsLabels.length; i++) {
          const domain = srd!.domains[i],
            label = dsLabels.get(i);
          label.position = scenePositions[domain.ds];
          label.show =
            dsLabels.length <= 16 ||
            domain.id === srd!.sourceDomain ||
            domain.id === srd!.membership[target ?? -1] ||
            (p.selected !== null &&
              domain.id === srd!.membership[p.selected]) ||
            Cartesian3.distance(viewer.camera.positionWC, label.position) <
              iconDistance / 2;
        }
        const styleKey = `${p.selected}:${source}:${target}:${srd?.membership.join(":") ?? ""}`;
        for (let id = 0; id < pos.length; id++) {
          const dot = points.get(id);
          dot.position = scenePositions[id];
          if (iconView) satelliteIcons.get(id).position = scenePositions[id];
          if (styleKey !== lastStyle) {
            const domain = srd?.domains[srd.membership[id]];
            const isDs = domain?.ds === id;
            satelliteIcons.get(id).color = srd
              ? Color.fromCssColorString(
                  palette[srd.membership[id] % palette.length],
                )
              : Color.WHITE;
            satelliteIcons.get(id).scale =
              id === p.selected ? 1.25 : isDs ? 1.15 : 1;
            dot.outlineColor = isDs ? Color.WHITE : Color.BLACK;
            dot.outlineWidth = isDs ? 3 : 1;
            dot.pixelSize =
              id === p.selected
                ? 11
                : id === source || id === target
                  ? 8
                  : isDs
                    ? 9
                    : 5;
            dot.color = Color.fromCssColorString(
              id === source
                ? "#80efbb"
                : id === target
                  ? "#ffbb78"
                  : palette[
                      (srd?.membership[id] ??
                        Math.floor(id / p.config.perPlane)) % palette.length
                    ],
            );
          }
        }
        lastStyle = styleKey;
        if (
          lastFrame !== display ||
          lastSelectedLink !== p.selectedLink ||
          styleKey !== lastLinkStyle
        ) {
          lastLinkStyle = styleKey;
          const visibleLinks =
            display?.links.filter(
              (link) =>
                link.physical || link.forced || (link.known && !link.physical),
            ) ?? [];
          const nextLinkKey = visibleLinks
            .map(
              (link) =>
                `${link.id}:${link.physical}:${link.known}:${link.id === p.selectedLink}:${srd?.membership[link.a] !== srd?.membership[link.b]}`,
            )
            .join(",");
          if (linkKey !== nextLinkKey) {
            wireGroups.forEach((group) => group.removeAll());
            wireIds = [];
            for (const link of visibleLinks) {
              const groupIndex = Math.floor(wireIds.length / linesPerGroup);
              const group =
                wireGroups[groupIndex] ??
                (wireGroups[groupIndex] = viewer.scene.primitives.add(
                  new PolylineCollection(),
                ) as PolylineCollection);
              const line = group.add({
                id: `isl:${link.id}`,
                positions: [scenePositions[link.a], scenePositions[link.b]],
                width:
                  link.id === p.selectedLink ||
                  (srd && srd.membership[link.a] !== srd.membership[link.b])
                    ? 2
                    : 1,
              });
              line.material.uniforms.color = Color.fromCssColorString(
                !link.physical
                  ? "#ff7a82"
                  : link.id === p.selectedLink
                    ? "#cce4fa"
                    : srd && srd.membership[link.a] !== srd.membership[link.b]
                      ? "#d8b4ff"
                      : "#3f97b5",
              ).withAlpha(
                !link.physical || link.id === p.selectedLink
                  ? 0.9
                  : srd && srd.membership[link.a] !== srd.membership[link.b]
                    ? 0.65
                    : 0.22,
              );
              wireIds.push([link.a, link.b]);
            }
            linkKey = nextLinkKey;
          }
          lastFrame = display;
          lastSelectedLink = p.selectedLink;
        }
        wireGroups.forEach((group) => {
          group.show = p.links;
        });
        // Every visible primitive uses the same interpolated display time.
        if (p.links) {
          for (let i = 0; i < wireIds.length; i++) {
            const [a, b] = wireIds[i];
            wireGroups[Math.floor(i / linesPerGroup)].get(
              i % linesPerGroup,
            ).positions = [scenePositions[a], scenePositions[b]];
          }
        }
        const key = path.join(":");
        if (key !== routeKey) {
          paths.removeAll();
          if (path.length > 1)
            paths.add({
              positions: path.map((id) => scenePositions[id]),
              width: 3,
            });
          routeKey = key;
        }
        if (paths.length) {
          paths.get(0).positions = path.map((id) => scenePositions[id]);
          paths.get(0).material.uniforms.color = Color.fromCssColorString(
            display?.pathValid ? "#80efbb" : "#ff7a82",
          ).withAlpha(0.9);
        }
        const preview = p.previewPath;
        const nextPreview = preview.join(":") + styleKey;
        if (nextPreview !== previewKey) {
          previewLines.removeAll();
          if (!srd && preview.length > 1) {
            const line = previewLines.add({
              positions: preview.map((id) => scenePositions[id]),
              width: 5,
            });
            line.material.uniforms.color =
              Color.fromCssColorString("#7eaaff").withAlpha(0.85);
          } else
            for (let i = 1; i < preview.length; i++) {
              const a = preview[i - 1],
                b = preview[i];
              const line = previewLines.add({
                positions: [scenePositions[a], scenePositions[b]],
                width: 5,
              });
              line.material.uniforms.color = Color.fromCssColorString(
                srd && srd.membership[a] === srd.membership[b]
                  ? palette[srd.membership[a] % palette.length]
                  : "#7eaaff",
              ).withAlpha(0.85);
            }
          previewKey = nextPreview;
        }
        for (let i = 0; i < previewLines.length; i++)
          previewLines.get(i).positions = srd
            ? [scenePositions[preview[i]], scenePositions[preview[i + 1]]]
            : preview.map((id) => scenePositions[id]);
        const flights = p.showControl
          ? (display?.mcsr?.control?.flights ?? [])
          : [];
        for (
          let i = 0;
          i < Math.max(controlPoints.length, flights.length);
          i++
        ) {
          if (i >= controlPoints.length)
            controlPoints.add({
              position: Cartesian3.ZERO,
              pixelSize: 8,
              outlineWidth: 1,
              outlineColor: Color.WHITE,
            });
          const dot = controlPoints.get(i),
            f = flights[i];
          dot.show = !!f;
          if (!f) continue;
          dot.id = `control:${f.kind}:${f.messageId}`;
          dot.color = Color.fromCssColorString(
            f.kind === "ack" ? "#db9aff" : "#4eeaff",
          );
          const a = f.path[f.hop],
            b = f.path[f.hop + 1];
          if (a !== undefined && b !== undefined) {
            const t = Math.max(
              0,
              Math.min(
                1,
                (displayClock.at(now) - f.departedUs) /
                  Math.max(1, f.arrivesUs - f.departedUs),
              ),
            );
            dot.position = Cartesian3.lerp(
              scenePositions[a],
              scenePositions[b],
              t,
              new Cartesian3(),
            );
          } else {
            const node = display?.mcsr?.domains[f.origin]?.ds;
            if (node !== undefined) dot.position = scenePositions[node];
          }
        }
        const controlPath =
            p.showControl &&
            p.controlPath.every((id) => id >= 0 && id < scenePositions.length)
              ? p.controlPath
              : [],
          controlKey = controlPath.join(":");
        if (controlKey !== controlPathKey) {
          controlLines.removeAll();
          if (controlPath.length > 1) {
            const line = controlLines.add({
              positions: controlPath.map((id) => scenePositions[id]),
              width: 4,
            });
            line.material.uniforms.color =
              Color.fromCssColorString("#ffc477").withAlpha(0.9);
          }
          controlPathKey = controlKey;
        }
        if (controlLines.length)
          controlLines.get(0).positions = controlPath.map(
            (id) => scenePositions[id],
          );
        const flowPositions = path.map((id) => scenePositions[id]);
        if (ground?.available && groundPositions.ut && groundPositions.gs) {
          flowPositions.unshift(groundPositions.ut);
          flowPositions.push(groundPositions.gs);
        }
        for (let i = 0; i < packets.length; i++) {
          const dot = packets.get(i);
          dot.show =
            flowPositions.length > 1 &&
            !!display?.pathValid &&
            (!ground || ground.available);
          if (!dot.show) continue;
          const progress = (((seconds / 16 + i / packets.length) % 1) + 1) % 1;
          const hop = progress * (flowPositions.length - 1);
          const index = Math.min(Math.floor(hop), flowPositions.length - 2);
          dot.position = Cartesian3.lerp(
            flowPositions[index],
            flowPositions[index + 1],
            hop - index,
            new Cartesian3(),
          );
        }
        if (
          lastSelected !== p.selected ||
          lastAll !== p.allOrbits ||
          Math.floor(seconds / 15) !== orbitBucket
        ) {
          orbits.removeAll();
          const planes = p.allOrbits
            ? Array.from({ length: p.config.planes }, (_, i) => i)
            : p.selected === null
              ? []
              : [Math.floor(p.selected / p.config.perPlane)];
          for (const plane of planes) {
            const orbit = Array.from({ length: 181 }, (_, i) =>
              cart(
                fixed(
                  inertial(p.config, plane, 0, (i / 180) * period(p.config)),
                  gmst(p.startMs + seconds * 1000),
                ),
              ),
            );
            const line = orbits.add({ positions: orbit, width: 1 });
            line.material.uniforms.color = Color.fromCssColorString(
              palette[plane % palette.length],
            ).withAlpha(0.38);
          }
          lastSelected = p.selected;
          lastAll = p.allOrbits;
          orbitBucket = Math.floor(seconds / 15);
        }
        if (lastHome !== p.home) {
          viewer.camera.lookAtTransform(Matrix4.IDENTITY);
          viewer.camera.setView({
            destination: Cartesian3.fromDegrees(
              p.groundSettings?.ut?.longitude ??
                p.groundSettings?.gs?.longitude ??
                118,
              p.groundSettings?.ut?.latitude ??
                p.groundSettings?.gs?.latitude ??
                18,
              21000000,
            ),
            orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
          });
          centerOnEarth();
          lastHome = p.home;
        }
        const isTracking = p.tracking && p.selected !== null;
        controller.minimumZoomDistance = isTracking
          ? 10000
          : EARTH_RADIUS + 250000;
        controller.maximumZoomDistance = isTracking
          ? 50000000
          : EARTH_RADIUS + 50000000;
        if (p.tracking && p.selected !== null) {
          viewer.camera.lookAt(
            cart(pos[p.selected]),
            new HeadingPitchRange(0, -0.5, 1500000),
          );
        } else if (lastTrack) {
          centerOnEarth();
        }
        lastTrack = p.tracking;
        if (now - lastReport >= 250) {
          const location =
            p.selected === null
              ? null
              : Cartographic.fromCartesian(cart(pos[p.selected]));
          current.current.onTelemetry({
            latitude: location ? CMath.toDegrees(location.latitude) : 0,
            longitude: location ? CMath.toDegrees(location.longitude) : 0,
            altitude: location ? location.height / 1000 : 0,
          });
          lastReport = now;
        }
      };
      viewer.scene.preUpdate.addEventListener(update);
      viewer.scene.renderError.addEventListener((_scene, error) => {
        if (!disposed)
          current.current.onError(`3D 렌더링 오류: ${String(error)}`);
      });
    } catch (error) {
      props.onError(
        `3D 초기화 실패: WebGL과 하드웨어 가속을 확인하세요. ${String(error)}`,
      );
    }
    return () => {
      disposed = true;
      releaseRotation();
      handler?.destroy();
      if (viewer && !viewer.isDestroyed()) viewer.destroy();
    };
  }, [props.startMs]);
  return (
    <div className="globe-shell" onContextMenu={(e) => e.preventDefault()}>
      <div
        className="globe"
        ref={container}
        aria-label="LEO 위성망 3D 지구본"
      />
      {menu && (
        <div
          ref={menuElement}
          className="ground-menu"
          role="menu"
          aria-label="지상 노드 지정"
          style={{ left: menu.x, top: menu.y }}
        >
          <span>
            {menu.point.latitude.toFixed(4)}°, {menu.point.longitude.toFixed(4)}
            °
          </span>
          <button
            role="menuitem"
            onClick={() => {
              props.onGroundPick("ut", menu.point);
              setMenu(null);
            }}
          >
            여기에 사용자 단말(UT) 지정
          </button>
          <button
            role="menuitem"
            onClick={() => {
              props.onGroundPick("gs", menu.point);
              setMenu(null);
            }}
          >
            여기에 지상국(GS) 지정
          </button>
          <button role="menuitem" onClick={() => setMenu(null)}>
            닫기
          </button>
        </div>
      )}
    </div>
  );
}
