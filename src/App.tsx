import { useState, useMemo } from "react";
import Globe from "./Globe";
import type { Snapshot } from "./Globe";
import { PRESETS, validate, period, DAY } from "./model";
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
          SAT-{String(id).padStart(4, "0")}
        </option>
      )),
    [config],
  );
  return (
    <main className="app">
      <header className="topbar">
        <h1>
          MCSR <span>위성망 시뮬레이터</span>
        </h1>
        <nav aria-label="화면 제어">
          <button
            aria-expanded={left}
            onClick={() => {
              setLeft((v) => !v);
              if (window.innerWidth <= 850) setRight(false);
            }}
          >
            성좌 설정
          </button>
          <button
            aria-expanded={right}
            onClick={() => {
              setRight((v) => !v);
              if (window.innerWidth <= 850) setLeft(false);
            }}
          >
            위성 정보
          </button>
          <button
            onClick={() => {
              setTracking(false);
              setHome((v) => v + 1);
            }}
          >
            전체 보기
          </button>
        </nav>
      </header>
      <div className="workspace">
        {left && (
          <aside className="panel config-panel" aria-label="성좌 설정 패널">
            <h2>성좌 설정</h2>
            <label className="field">
              프리셋
              <select
                aria-label="성좌 프리셋"
                defaultValue="0"
                onChange={(e) =>
                  setDraft({ ...PRESETS[Number(e.target.value)].config })
                }
              >
                {PRESETS.map((p, i) => (
                  <option key={p.name} value={i}>
                    {i === 0 ? "기본 · 72기" : "Starlink S1 · 1,584기"}
                  </option>
                ))}
              </select>
            </label>
            <div className="field-grid">
              {(
                [
                  ["planes", "궤도 수", "개"],
                  ["perPlane", "궤도당 위성", "기"],
                  ["altitude", "궤도 고도", "km"],
                  ["inclination", "경사각", "°"],
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
                        key === "altitude" || key === "inclination"
                          ? "any"
                          : "1"
                      }
                      onChange={(e) =>
                        setDraft((d) => ({
                          ...d,
                          [key]:
                            e.target.value === ""
                              ? NaN
                              : Number(e.target.value),
                        }))
                      }
                    />
                    <span>{unit}</span>
                  </div>
                </label>
              ))}
            </div>
            <div className="config-total">
              <span>위성 수</span>
              <strong>
                {Number.isFinite(draft.planes * draft.perPlane)
                  ? (draft.planes * draft.perPlane).toLocaleString()
                  : "—"}
                기
              </strong>
            </div>
            {inputError && (
              <p className="field-error" role="alert">
                {inputError}
              </p>
            )}
            <button className="primary" onClick={apply}>
              성좌 적용
            </button>
            <section className="panel-section">
              <h2>표시</h2>
              <label className="switch-row">
                위성 간 연결
                <input
                  type="checkbox"
                  checked={links}
                  onChange={(e) => setLinks(e.target.checked)}
                />
              </label>
              <label className="switch-row">
                전체 궤도선
                <input
                  type="checkbox"
                  checked={allOrbits}
                  onChange={(e) => setAllOrbits(e.target.checked)}
                />
              </label>
            </section>
          </aside>
        )}
        <section className="viewport" aria-label="시뮬레이션">
          <div className="globe-frame">
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
          </div>
          <div className="viewport-meta">
            <div className="scene-stats">
              <span>
                위성{" "}
                <strong>
                  {(config.planes * config.perPlane).toLocaleString()}
                </strong>
                기
              </span>
              <span>
                연결 <strong>{snapshot.links.toLocaleString()}</strong>개
              </span>
              <span>
                고도 <strong>{config.altitude}</strong> km
              </span>
            </div>
            <div className="legend" aria-label="범례">
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
                경로
              </span>
              <span>
                <i className="legend-packet" />
                패킷
              </span>
            </div>
          </div>
        </section>
        {right && (
          <aside
            className="panel info-panel"
            aria-label="통신 및 위성 정보 패널"
          >
            <section>
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
                  aria-label="선택 위성을 출발 노드로"
                  onClick={() => selected !== null && setSource(selected)}
                >
                  지정
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
                  aria-label="선택 위성을 도착 노드로"
                  onClick={() => selected !== null && setTarget(selected)}
                >
                  지정
                </button>
              </div>
              <div className="route-summary">
                <span>
                  {snapshot.path.length > 1
                    ? `${snapshot.path.length - 1} 홉`
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
                  : "연결 가능한 경로가 없습니다."}
              </p>
              <span
                className="route-method"
                title="MCSR 미적용. 패킷 이동 속도는 실제 전송 속도와 다릅니다."
                aria-label="최단 홉 시각화. MCSR 미적용. 패킷 이동 속도는 실제 전송 속도와 다릅니다."
              >
                최단 홉 · 시각화
              </span>
            </section>
            <section className="panel-section">
              <h2>위성 정보</h2>
              <label className="field">
                선택 위성
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
                  <option value="">선택 없음</option>
                  {nodes}
                </select>
              </label>
              {selected !== null ? (
                <>
                  <dl className="telemetry">
                    <div>
                      <dt>궤도 / 위성</dt>
                      <dd>
                        {Math.floor(selected / config.perPlane) + 1} /{" "}
                        {(selected % config.perPlane) + 1}
                      </dd>
                    </div>
                    <div>
                      <dt>위도</dt>
                      <dd>{snapshot.latitude.toFixed(3)}°</dd>
                    </div>
                    <div>
                      <dt>경도</dt>
                      <dd>{snapshot.longitude.toFixed(3)}°</dd>
                    </div>
                    <div>
                      <dt>고도</dt>
                      <dd>
                        {snapshot.altitude.toFixed(1)}
                        <small> km</small>
                      </dd>
                    </div>
                    <div>
                      <dt>공전 주기</dt>
                      <dd>
                        {(period(config) / 60).toFixed(1)}
                        <small> 분</small>
                      </dd>
                    </div>
                  </dl>
                  <button
                    className={"secondary " + (tracking ? "active" : "")}
                    onClick={() => setTracking((v) => !v)}
                  >
                    {tracking ? "추적 해제" : "위성 추적"}
                  </button>
                </>
              ) : null}
            </section>
          </aside>
        )}
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
            title="시간 초기화"
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
              <option key={v} value={v}>
                {v}×
              </option>
            ))}
          </select>
        </div>
        <div className="time-track">
          <time>
            {utc}
            <small> UTC</small>
          </time>
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
        <span className="run-status">
          {snapshot.seconds >= DAY ? "종료" : playing ? "재생 중" : "일시정지"}
        </span>
      </footer>
      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button onClick={() => setError("")} aria-label="오류 닫기">
            ×
          </button>
        </div>
      )}
    </main>
  );
}
