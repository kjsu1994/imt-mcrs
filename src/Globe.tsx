import { useEffect, useRef } from "react";
import {
  Viewer,
  SingleTileImageryProvider,
  Rectangle,
  Cartesian2,
  Cartesian3,
  Color,
  PointPrimitiveCollection,
  PolylineCollection,
  JulianDate,
  ClockRange,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  Math as CMath,
  Cartographic,
  HeadingPitchRange,
  Matrix4,
  Credit,
  EllipsoidTerrainProvider,
} from "cesium";
import {
  activeEdges,
  mesh,
  positions,
  route,
  pathLength,
  inertial,
  fixed,
  gmst,
  DAY,
  period,
} from "./model";
import type { Config, Vec3 } from "./model";
export type Snapshot = {
  seconds: number;
  latitude: number;
  longitude: number;
  altitude: number;
  links: number;
  path: number[];
  length: number;
  fps: number;
};
type Props = {
  config: Config;
  startMs: number;
  playing: boolean;
  speed: number;
  seek: { seconds: number; revision: number };
  selected: number | null;
  source: number;
  target: number;
  links: boolean;
  allOrbits: boolean;
  tracking: boolean;
  home: number;
  onPick: (id: number) => void;
  onSnapshot: (s: Snapshot) => void;
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
  const container = useRef<HTMLDivElement>(null),
    current = useRef(props);
  current.current = props;
  useEffect(() => {
    let viewer: Viewer | undefined,
      handler: ScreenSpaceEventHandler | undefined,
      disposed = false;
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
      const start = JulianDate.fromDate(new Date(props.startMs));
      viewer.clock.startTime = start.clone();
      viewer.clock.stopTime = JulianDate.addSeconds(
        start,
        DAY,
        new JulianDate(),
      );
      viewer.clock.currentTime = start.clone();
      viewer.clock.clockRange = ClockRange.CLAMPED;
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
      const packets = viewer.scene.primitives.add(
        new PointPrimitiveCollection(),
      ) as PointPrimitiveCollection;
      const wires = viewer.scene.primitives.add(
        new PolylineCollection(),
      ) as PolylineCollection;
      const paths = viewer.scene.primitives.add(
        new PolylineCollection(),
      ) as PolylineCollection;
      const orbits = viewer.scene.primitives.add(
        new PolylineCollection(),
      ) as PolylineCollection;
      let config: Config | null = null,
        edges: [number, number][] = [],
        wireIds: [number, number][] = [],
        lastSelected: number | null | undefined,
        lastAll: boolean | undefined,
        lastHome = -1,
        lastSeek = -1,
        routeKey = "",
        linkKey = "",
        orbitBucket = -1,
        lastReport = 0,
        lastLines = -Infinity,
        lastStyle = "",
        lastEndpoints = "",
        lastTopology = -Infinity,
        active: [number, number][] = [],
        path: number[] = [],
        frames: number[] = [],
        lastFrame = performance.now(),
        lastTrack = false;
      handler = new ScreenSpaceEventHandler(viewer.scene.canvas);
      handler.setInputAction((event: { position: Cartesian2 }) => {
        const picked = viewer!.scene.pick(event.position);
        if (picked && typeof picked.id === "number")
          current.current.onPick(picked.id);
      }, ScreenSpaceEventType.LEFT_CLICK);
      const update = () => {
        if (!viewer || viewer.isDestroyed()) return;
        const p = current.current,
          now = performance.now();
        frames.push(now - lastFrame);
        lastFrame = now;
        if (frames.length > 120) frames.shift();
        viewer.clock.shouldAnimate = p.playing;
        viewer.clock.multiplier = p.speed;
        if (lastSeek !== p.seek.revision) {
          viewer.clock.currentTime = JulianDate.addSeconds(
            start,
            p.seek.seconds,
            new JulianDate(),
          );
          lastSeek = p.seek.revision;
          lastTopology = -Infinity;
        }
        const seconds = JulianDate.secondsDifference(
          viewer.clock.currentTime,
          start,
        );
        if (config !== p.config) {
          config = p.config;
          edges = mesh(config);
          points.removeAll();
          packets.removeAll();
          wires.removeAll();
          paths.removeAll();
          orbits.removeAll();
          for (let id = 0; id < config.planes * config.perPlane; id++)
            points.add({
              id,
              position: Cartesian3.ZERO,
              pixelSize: 5,
              color: Color.fromCssColorString(
                palette[Math.floor(id / config.perPlane) % palette.length],
              ),
              outlineColor: Color.BLACK,
              outlineWidth: 1,
            });
          for (let i = 0; i < 9; i++)
            packets.add({
              position: Cartesian3.ZERO,
              pixelSize: 6,
              color: Color.fromCssColorString("#fff0a6"),
              outlineWidth: 1,
              outlineColor: Color.fromCssColorString("#e8aa32"),
              show: false,
            });
          lastTopology = -Infinity;
          lastStyle = "";
          lastEndpoints = "";
          routeKey = "";
          linkKey = "";
          wireIds = [];
          lastSelected = undefined;
          orbitBucket = -1;
        }
        const pos = positions(p.config, seconds, p.startMs);
        const styleKey = `${p.selected}:${p.source}:${p.target}`;
        for (let id = 0; id < pos.length; id++) {
          const dot = points.get(id);
          dot.position = cart(pos[id]);
          if (styleKey !== lastStyle) {
            dot.pixelSize =
              id === p.selected
                ? 11
                : id === p.source || id === p.target
                  ? 8
                  : 5;
            dot.color = Color.fromCssColorString(
              id === p.source
                ? "#80efbb"
                : id === p.target
                  ? "#ffbb78"
                  : palette[
                      Math.floor(id / p.config.perPlane) % palette.length
                    ],
            );
          }
        }
        lastStyle = styleKey;
        const topologyChanged = Math.abs(seconds - lastTopology) >= 1;
        if (topologyChanged) {
          active = activeEdges(edges, pos);
          lastTopology = seconds;
        }
        const endpointKey = `${p.source}:${p.target}`;
        if (topologyChanged || endpointKey !== lastEndpoints) {
          path = route(pos.length, active, p.source, p.target);
          lastEndpoints = endpointKey;
        }
        if (topologyChanged) {
          const nextLinkKey = active.map((e) => e.join(":")).join(",");
          if (linkKey !== nextLinkKey) {
            wires.removeAll();
            wireIds = active;
            for (const [a, b] of active) {
              const line = wires.add({
                positions: [cart(pos[a]), cart(pos[b])],
                width: 1,
              });
              line.material.uniforms.color =
                Color.fromCssColorString("#3f97b5").withAlpha(0.22);
            }
            linkKey = nextLinkKey;
          }
        }
        wires.show = p.links;
        // Background mesh updates at 10 Hz; selected route and packets remain frame-synchronous.
        if (p.links && now - lastLines >= 100) {
          for (let i = 0; i < wireIds.length; i++) {
            const [a, b] = wireIds[i];
            wires.get(i).positions = [cart(pos[a]), cart(pos[b])];
          }
          lastLines = now;
        }
        const key = path.join(":");
        if (key !== routeKey) {
          paths.removeAll();
          if (path.length > 1)
            paths.add({ positions: path.map((id) => cart(pos[id])), width: 3 });
          routeKey = key;
        }
        if (paths.length) {
          paths.get(0).positions = path.map((id) => cart(pos[id]));
          paths.get(0).material.uniforms.color =
            Color.fromCssColorString("#80efbb").withAlpha(0.9);
        }
        for (let i = 0; i < packets.length; i++) {
          const dot = packets.get(i);
          dot.show = path.length > 1;
          if (path.length > 1) {
            const progress =
                (((seconds / 16 + i / packets.length) % 1) + 1) % 1,
              hop = progress * (path.length - 1),
              index = Math.min(Math.floor(hop), path.length - 2),
              a = pos[path[index]],
              b = pos[path[index + 1]],
              t = hop - index;
            dot.position = new Cartesian3(
              a.x + (b.x - a.x) * t,
              a.y + (b.y - a.y) * t,
              a.z + (b.z - a.z) * t,
            );
          }
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
            destination: Cartesian3.fromDegrees(118, 18, 21000000),
            orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
          });
          lastHome = p.home;
        }
        if (p.tracking && p.selected !== null) {
          viewer.camera.lookAt(
            cart(pos[p.selected]),
            new HeadingPitchRange(0, -0.5, 1500000),
          );
        } else if (lastTrack) {
          viewer.camera.lookAtTransform(Matrix4.IDENTITY);
        }
        lastTrack = p.tracking;
        if (now - lastReport >= 250) {
          const location =
            p.selected === null
              ? null
              : Cartographic.fromCartesian(cart(pos[p.selected]));
          current.current.onSnapshot({
            seconds,
            latitude: location ? CMath.toDegrees(location.latitude) : 0,
            longitude: location ? CMath.toDegrees(location.longitude) : 0,
            altitude: location ? location.height / 1000 : 0,
            links: active.length,
            path,
            length: pathLength(path, pos),
            fps: frames.length
              ? 1000 /
                [...frames].sort((a, b) => a - b)[Math.floor(frames.length / 2)]
              : 0,
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
      handler?.destroy();
      if (viewer && !viewer.isDestroyed()) viewer.destroy();
    };
  }, [props.startMs]);
  return (
    <div className="globe" ref={container} aria-label="LEO 위성망 3D 지구본" />
  );
}
