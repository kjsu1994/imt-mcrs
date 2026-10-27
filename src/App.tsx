import { useState, useMemo } from "react";
import Globe from "./Globe";
import type { Snapshot } from "./Globe";
import { PRESETS, validate, period, DAY } from "./model";
import type { Config } from "./model";
const initial: Snapshot = {
  seconds: 0,
  latitude: 0,
  longitude: 0,
  altitude: 0,
  links: 0,
  path: [],
  length: 0,
  fps: 0,
};
const idLabel = (id: number, c: Config) =>
  `SAT-${String(id).padStart(4, "0")} / P${String(Math.floor(id / c.perPlane) + 1).padStart(2, "0")}`;
export default function App() {
  const [config, setConfig] = useState(PRESETS[0].config),
    [draft, setDraft] = useState(config),
    [startMs] = useState(() => Date.now()),
    [playing, setPlaying] = useState(true),
    [speed, setSpeed] = useState(10),
    [seek, setSeek] = useState({ seconds: 0, revision: 0 }),
    [selected, setSelected] = useState<number | null>(0),
    [source, setSource] = useState(0),
    [target, setTarget] = useState(41),
    [links, setLinks] = useState(true),
    [allOrbits, setAllOrbits] = useState(false),
    [tracking, setTracking] = useState(false),
    [home, setHome] = useState(0),
    [snapshot, setSnapshot] = useState(initial),
    [error, setError] = useState(""),
    [inputError, setInputError] = useState(""),
    [left, setLeft] = useState(() => window.innerWidth > 850),
    [right, setRight] = useState(() => window.innerWidth > 850);
  function jump(seconds: number) {
    setSeek((s) => ({ seconds, revision: s.revision + 1 }));
  }
  function apply() {
    const message = validate(draft);
    if (message) {
      setInputError(message);
      return;
    }
    setConfig({ ...draft });
    setSelected(null);
    setTracking(false);
    setSource(0);
    setTarget(Math.min(41, draft.planes * draft.perPlane - 1));
    setInputError("");
    setHome((v) => v + 1);
    jump(0);
  }
  const utc = new Date(startMs + snapshot.seconds * 1000)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);
  const nodes = useMemo(
    () =>
      Array.from({ length: config.planes * config.perPlane }, (_, id) => (
        <option key={id} value={id}>
          {idLabel(id, config)}
        </option>
      )),
    [config],
  );
  return (
    <main className="app">
      <Globe
        config={config}
        startMs={startMs}
        playing={playing}
        speed={speed}
        seek={seek}
        selected={selected}
        source={source}
        target={target}
        links={links}
        allOrbits={allOrbits}
        tracking={tracking}
        home={home}
        onPick={setSelected}
        onSnapshot={setSnapshot}
        onError={setError}
      />
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">◎</span>
          <div>
            <strong>
              MCSR<span className="thin"> / ORBITAL LAB</span>
            </strong>
            <small>LEO NETWORK SIMULATOR</small>
          </div>
        </div>
        <div className="header-center">
          <span className="status-dot" /> LOCAL SIMULATION{" "}
          <span className="divider">/</span> WALKER DELTA
        </div>
        <div className="header-right">
          <span className="pill">VISUALIZATION v0.1</span>
          <button
            className="icon-button"
            onClick={() => {
              setTracking(false);
              setHome((v) => v + 1);
            }}
          >
            ↗ 전체 보기
          </button>
        </div>
      </header>
      <div className="scene-title">
        <span className="eyebrow">MISSION CONTROL / 01</span>
        <h1>위성 사이의 흐름을 보다.</h1>
        <p>지구 궤도 위, 연결되는 네트워크.</p>
      </div>
      <button
        className="panel-toggle toggle-left"
        aria-expanded={left}
        onClick={() => {
          setLeft((v) => !v);
          if (window.innerWidth <= 850) setRight(false);
        }}
      >
        {left ? "‹ 설정 접기" : "› 성좌 설정"}
      </button>
      {left && (
        <aside className="panel config-panel">
          <div className="section-heading">
            <span className="eyebrow">CONSTELLATION</span>
            <span className="section-number">01</span>
          </div>
          <h2>성좌 설정</h2>
          <label className="field">
            프리셋
            <select
              aria-label="성좌 프리셋"
              onChange={(e) =>
                setDraft({ ...PRESETS[Number(e.target.value)].config })
              }
              defaultValue="0"
            >
              {PRESETS.map((p, i) => (
                <option value={i} key={p.name}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <div className="field-grid">
            {(
              [
                ["planes", "궤도 수", "planes"],
                ["perPlane", "궤도당 위성", "nodes"],
                ["altitude", "궤도 고도", "km"],
                ["inclination", "경사각", "deg"],
                ["phase", "위상 인자", "f"],
              ] as const
            ).map(([key, label, unit]) => (
              <label className="field" key={key}>
                {label}
                <div className="input-unit">
                  <input
                    type="number"
                    aria-label={label}
                    value={Number.isNaN(draft[key]) ? "" : draft[key]}
                    step={
                      key === "altitude" || key === "inclination" ? "any" : "1"
                    }
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        [key]:
                          e.target.value === "" ? NaN : Number(e.target.value),
                      }))
                    }
                  />
                  <span>{unit}</span>
                </div>
              </label>
            ))}
          </div>
          <div className="config-total">
            <span>설정 위성 수</span>
            <strong>
              {Number.isFinite(draft.planes * draft.perPlane)
                ? (draft.planes * draft.perPlane).toLocaleString()
                : "—"}{" "}
              <small>nodes</small>
            </strong>
          </div>
          {inputError && (
            <p className="field-error" role="alert">
              {inputError}
            </p>
          )}
          <button className="primary" onClick={apply}>
            성좌 적용 <span>↗</span>
          </button>
          <div className="panel-separator" />
          <div className="section-heading">
            <span className="eyebrow">DISPLAY LAYERS</span>
            <span className="section-number">02</span>
          </div>
          <label className="switch-row">
            <span>
              위성 간 연결 <small>Inter-satellite links</small>
            </span>
            <input
              type="checkbox"
              checked={links}
              onChange={(e) => setLinks(e.target.checked)}
            />
          </label>
          <label className="switch-row">
            <span>
              전체 궤도선 <small>Orbital planes</small>
            </span>
            <input
              type="checkbox"
              checked={allOrbits}
              onChange={(e) => setAllOrbits(e.target.checked)}
            />
          </label>
          <div className="model-note">
            <span>ⓘ</span>
            <p>
              가상 원형 궤도 · 실제 축척
              <br />
              선택 위성의 궤도는 자동 표시됩니다.
            </p>
          </div>
        </aside>
      )}
      <button
        className="panel-toggle toggle-right"
        aria-expanded={right}
        onClick={() => {
          setRight((v) => !v);
          if (window.innerWidth <= 850) setLeft(false);
        }}
      >
        {right ? "정보 접기 ›" : "위성 정보 ‹"}
      </button>
      {right && (
        <aside className="panel info-panel">
          <div className="section-heading">
            <span className="eyebrow">SATELLITE INSPECTOR</span>
            <span className="section-number">03</span>
          </div>
          <h2>
            위성 정보 <span className="live-tag">LIVE</span>
          </h2>
          <label className="field">
            위성 선택
            <select
              aria-label="위성 선택"
              value={selected ?? ""}
              onChange={(e) => {
                setSelected(
                  e.target.value === "" ? null : Number(e.target.value),
                );
                setTracking(false);
              }}
            >
              <option value="">지구본에서 위성을 선택하세요</option>
              {nodes}
            </select>
          </label>
          {selected !== null ? (
            <>
              <div className="satellite-id">
                <span className="sat-glyph">✧</span>
                <div>
                  <strong>SAT-{String(selected).padStart(4, "0")}</strong>
                  <small>
                    PLANE {Math.floor(selected / config.perPlane) + 1} / NODE{" "}
                    {(selected % config.perPlane) + 1}
                  </small>
                </div>
              </div>
              <dl className="telemetry">
                <div>
                  <dt>위도</dt>
                  <dd>
                    {snapshot.latitude.toFixed(3)}
                    <small>°</small>
                  </dd>
                </div>
                <div>
                  <dt>경도</dt>
                  <dd>
                    {snapshot.longitude.toFixed(3)}
                    <small>°</small>
                  </dd>
                </div>
                <div>
                  <dt>
                    고도 <small>WGS84</small>
                  </dt>
                  <dd>
                    {snapshot.altitude.toFixed(1)}
                    <small>km</small>
                  </dd>
                </div>
                <div>
                  <dt>공전 주기</dt>
                  <dd>
                    {(period(config) / 60).toFixed(1)}
                    <small>min</small>
                  </dd>
                </div>
              </dl>
              <button
                className={"secondary " + (tracking ? "active" : "")}
                onClick={() => setTracking((v) => !v)}
              >
                {tracking ? "⊙ 추적 해제" : "⊙ 위성 추적"}
              </button>
            </>
          ) : (
            <p className="empty">
              위성을 클릭하면 위치와 궤도 정보를 확인할 수 있습니다.
            </p>
          )}
          <div className="panel-separator" />
          <div className="section-heading">
            <span className="eyebrow">COMMUNICATION FLOW</span>
            <span className="section-number">04</span>
          </div>
          <h2>노드 간 통신</h2>
          <div className="endpoint">
            <span className="source-dot" />
            <label>
              출발 노드
              <select
                aria-label="출발 노드"
                value={source}
                onChange={(e) => setSource(Number(e.target.value))}
              >
                {nodes}
              </select>
            </label>
            <button
              disabled={selected === null}
              title="선택 위성을 출발 노드로"
              onClick={() => selected !== null && setSource(selected)}
            >
              선택
            </button>
          </div>
          <div className="endpoint">
            <span className="target-dot" />
            <label>
              도착 노드
              <select
                aria-label="도착 노드"
                value={target}
                onChange={(e) => setTarget(Number(e.target.value))}
              >
                {nodes}
              </select>
            </label>
            <button
              disabled={selected === null}
              title="선택 위성을 도착 노드로"
              onClick={() => selected !== null && setTarget(selected)}
            >
              선택
            </button>
          </div>
          <div className="route-summary">
            <span>
              {snapshot.path.length > 1
                ? `${snapshot.path.length - 1} HOPS`
                : source === target
                  ? "동일 노드"
                  : "경로 없음"}
            </span>
            <strong>
              {(snapshot.length / 1000).toLocaleString("en", {
                maximumFractionDigits: 0,
              })}
              <small> km</small>
            </strong>
          </div>
          <p className="route-path">
            {snapshot.path.length
              ? snapshot.path
                  .map((id) => String(id).padStart(4, "0"))
                  .join(" → ")
              : "지구에 가리지 않는 경로가 없습니다."}
          </p>
          <p className="flow-note">
            최단 홉 시연 · MCSR 미적용
            <br />
            이동 점은 관찰용 패킷이며 실제 전송 속도가 아닙니다.
          </p>
        </aside>
      )}
      <div className="scene-stats">
        <div>
          <small>ACTIVE SATELLITES</small>
          <strong>
            {(config.planes * config.perPlane).toLocaleString()}
            <span> nodes</span>
          </strong>
        </div>
        <div>
          <small>AVAILABLE LINKS</small>
          <strong>
            {snapshot.links.toLocaleString()}
            <span> ISLs</span>
          </strong>
        </div>
        <div>
          <small>ORBITAL ALTITUDE</small>
          <strong>
            {config.altitude}
            <span> km</span>
          </strong>
        </div>
        <div>
          <small>RENDER</small>
          <strong>
            {snapshot.fps.toFixed(0)}
            <span> FPS</span>
          </strong>
        </div>
      </div>
      <div className="legend">
        <span>
          <i />
          위성
        </span>
        <span>
          <i className="legend-link" />
          ISL
        </span>
        <span>
          <i className="legend-route" />
          선택 경로
        </span>
        <span>
          <i className="legend-packet" />
          패킷 흐름
        </span>
      </div>
      <footer className="timeline">
        <div className="playback">
          <button
            aria-label={playing ? "일시정지" : "재생"}
            className="play"
            onClick={() => setPlaying((v) => !v)}
          >
            {playing ? "Ⅱ" : "▶"}
          </button>
          <button
            aria-label="시간 초기화"
            className="reset"
            onClick={() => jump(0)}
          >
            ↺
          </button>
          <select
            aria-label="재생 속도"
            value={speed}
            onChange={(e) => setSpeed(Number(e.target.value))}
          >
            {[1, 10, 60, 300].map((v) => (
              <option value={v} key={v}>
                {v}×
              </option>
            ))}
          </select>
        </div>
        <div className="time-track">
          <div className="time-labels">
            <span>SIMULATION TIME</span>
            <time>
              {utc}
              <small> UTC</small>
            </time>
          </div>
          <input
            aria-label="시뮬레이션 시간"
            type="range"
            min="0"
            max={DAY}
            step="1"
            value={snapshot.seconds}
            onChange={(e) => jump(Number(e.target.value))}
          />
          <div className="time-ticks">
            <span>+00:00</span>
            <span>+06:00</span>
            <span>+12:00</span>
            <span>+18:00</span>
            <span>+24:00</span>
          </div>
        </div>
        <div className="run-status">
          <span className={"status-dot " + (!playing ? "paused" : "")} />
          {snapshot.seconds >= DAY
            ? "END OF WINDOW"
            : playing
              ? "SIMULATION RUNNING"
              : "SIMULATION PAUSED"}
          <small>원형 2체 궤도 · LOCAL / OFFLINE</small>
        </div>
      </footer>
      {error && (
        <div className="error-banner" role="alert">
          {error}
          <button onClick={() => setError("")} aria-label="오류 닫기">
            ×
          </button>
        </div>
      )}
    </main>
  );
}
