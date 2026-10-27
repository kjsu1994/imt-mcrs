import { useState, useMemo, useEffect } from "react";
import Globe from "./Globe";
import type { Telemetry } from "./Globe";
import { PRESETS, validate, period, mesh } from "./model";
import { createScenario, validateScenario, SECOND, edgeId } from "./engine";
import { useSimulation } from "./useSimulation";
const initial: Telemetry = { latitude: 0, longitude: 0, altitude: 0 };
const defaultExperiment = {
  durationSeconds: 86400,
  slsMs: 100,
  computeMs: 1,
  installMs: 1,
  seed: 1,
};
export default function App() {
  const [config, setConfig] = useState(PRESETS[0].config),
    [draft, setDraft] = useState(config),
    [startMs] = useState(() => Date.now()),
    [playing, setPlaying] = useState(true),
    [speed, setSpeed] = useState(10),
    [selected, setSelected] = useState<number | null>(0),
    [source, setSource] = useState(0),
    [target, setTarget] = useState(41),
    [links, setLinks] = useState(true),
    [allOrbits, setAllOrbits] = useState(false),
    [tracking, setTracking] = useState(false),
    [home, setHome] = useState(0),
    [telemetry, setTelemetry] = useState(initial),
    [experiment, setExperiment] = useState(defaultExperiment),
    [experimentDraft, setExperimentDraft] = useState(defaultExperiment),
    [selectedLink, setSelectedLink] = useState("0:1"),
    [scheduleSeconds, setScheduleSeconds] = useState(120),
    [error, setError] = useState(""),
    [inputError, setInputError] = useState(""),
    [left, setLeft] = useState(() => window.innerWidth > 850),
    [right, setRight] = useState(() => window.innerWidth > 850);
  const scenario = useMemo(
    () => ({
      ...createScenario(config, startMs, source, target),
      durationUs: Math.round(experiment.durationSeconds * SECOND),
      slsIntervalUs: Math.round(experiment.slsMs * 1000),
      computeDelayUs: Math.round(experiment.computeMs * 1000),
      installDelayUs: Math.round(experiment.installMs * 1000),
      seed: experiment.seed,
    }),
    [config, startMs, source, target, experiment],
  );
  const simulation = useSimulation(scenario, playing, speed);
  useEffect(() => {
    if (simulation.ended) setPlaying(false);
  }, [simulation.ended]);
  const frame = simulation.frame;
  const snapshot = {
    ...telemetry,
    seconds: (frame?.timeUs ?? 0) / SECOND,
    path: frame?.path ?? [],
    length: frame?.length ?? 0,
    links: frame?.links.filter((l) => l.physical).length ?? 0,
  };
  const edgeOptions = useMemo(
    () => mesh(config).map(([a, b]) => edgeId(a, b)),
    [config],
  );
  const linkOptions = useMemo(
    () => edgeOptions.map((id) => (
      <option key={id} value={id}>{id.replace(":", " ↔ ")}</option>
    )),
    [edgeOptions],
  );
  const linkId = edgeOptions.includes(selectedLink)
    ? selectedLink
    : (edgeOptions[0] ?? "");
  function jump(seconds: number) {
    simulation.seek(Math.round(seconds * SECOND));
  }
  function applyExperiment() {
    try {
      validateScenario({
        ...scenario,
        durationUs: Math.round(experimentDraft.durationSeconds * SECOND),
        slsIntervalUs: Math.round(experimentDraft.slsMs * 1000),
        computeDelayUs: Math.round(experimentDraft.computeMs * 1000),
        installDelayUs: Math.round(experimentDraft.installMs * 1000),
        seed: experimentDraft.seed,
      });
      setExperiment({ ...experimentDraft });
      setInputError("");
    } catch (e) {
      setInputError(e instanceof Error ? e.message : String(e));
    }
  }
  function failure(down: boolean, immediate: boolean) {
    simulation.failure(
      { atUs: Math.round(scheduleSeconds * SECOND), linkId, down },
      immediate,
    );
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
        <div className="brand">
          <img
            src={`${import.meta.env.BASE_URL}textures/logo.png`}
            alt="MCSR"
          />
          <h1>위성망 시뮬레이터</h1>
        </div>
        <img
          className="org-logo"
          src={`${import.meta.env.BASE_URL}textures/imt_logo.png`}
          alt="IMT"
        />
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
            <section className="panel-section experiment-panel">
              <h2>실험</h2>
              <div className="field-grid">
                {(
                  [
                    ["durationSeconds", "실험 길이", "초"],
                    ["slsMs", "SLS 간격", "ms"],
                    ["computeMs", "계산 지연", "ms"],
                    ["installMs", "설치 지연", "ms"],
                    ["seed", "시드", ""],
                  ] as const
                ).map(([key, label, unit]) => (
                  <label key={key} className="field">
                    {label}
                    <div className="input-unit">
                      <input
                        type="number"
                        aria-label={label}
                        value={
                          Number.isNaN(experimentDraft[key])
                            ? ""
                            : experimentDraft[key]
                        }
                        onChange={(e) =>
                          setExperimentDraft((d) => ({
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
              <button className="secondary" onClick={applyExperiment}>
                실험 적용
              </button>
              <div className="button-row">
                <button
                  disabled={simulation.busy}
                  onClick={() => {
                    setPlaying(false);
                    simulation.step();
                  }}
                >
                  다음 사건
                </button>
                <button
                  disabled={simulation.busy}
                  onClick={() => {
                    setPlaying(false);
                    simulation.finish();
                  }}
                >
                  끝까지 실행
                </button>
              </div>
              <div className="button-row">
                <button
                  disabled={!frame || simulation.busy}
                  onClick={() => simulation.exportData("scenario")}
                >
                  시나리오 저장
                </button>
                <button
                  disabled={!frame || simulation.busy}
                  onClick={() => simulation.exportData("result")}
                >
                  결과 저장
                </button>
              </div>
              <p className="model-caption">
                SLS 3회 누락 감지 · 고정 처리시간 모델
              </p>
            </section>
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
              frame={frame}
              runId={simulation.runId}
              running={simulation.running}
              selectedLink={linkId}
              selected={selected}
              source={source}
              target={target}
              links={links}
              allOrbits={allOrbits}
              tracking={tracking}
              home={home}
              onPick={setSelected}
              onTelemetry={setTelemetry}
              onPickLink={setSelectedLink}
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
                <i className="legend-failed" />
                장애
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
            <section className="panel-section failure-panel">
              <h2>링크 장애</h2>
              <label className="field">
                선택 링크
                <select
                  aria-label="선택 링크"
                  value={linkId}
                  onChange={(e) => setSelectedLink(e.target.value)}
                >
                  {linkOptions}
                </select>
              </label>
              <div className="button-row">
                <button
                  disabled={
                    !frame || !linkId || simulation.busy || simulation.ended
                  }
                  onClick={() => failure(true, true)}
                >
                  장애 발생
                </button>
                <button
                  disabled={
                    !frame || !linkId || simulation.busy || simulation.ended
                  }
                  onClick={() => failure(false, true)}
                >
                  링크 복구
                </button>
              </div>
              <label className="field">
                예약 시각 (초)
                <input
                  aria-label="장애 예약 시각"
                  type="number"
                  value={scheduleSeconds}
                  onChange={(e) => setScheduleSeconds(Number(e.target.value))}
                />
              </label>
              <div className="button-row">
                <button
                  disabled={!frame || !linkId || simulation.busy}
                  onClick={() => failure(true, false)}
                >
                  장애 예약
                </button>
                <button
                  disabled={!frame || !linkId || simulation.busy}
                  onClick={() => failure(false, false)}
                >
                  복구 예약
                </button>
              </div>
              {frame?.scenario.failures.length ? (
                <details>
                  <summary>
                    장애 일정 {frame.scenario.failures.length}건
                  </summary>
                  <ol className="event-list">
                    {[...frame.scenario.failures]
                      .sort((a, b) => a.atUs - b.atUs)
                      .map((e, i) => (
                        <li key={i}>
                          {(e.atUs / SECOND).toFixed(3)}초 · {e.linkId} ·{" "}
                          {e.down ? "장애" : "복구"}
                        </li>
                      ))}
                  </ol>
                </details>
              ) : null}
              <h3>복구 기록</h3>
              <ul className="recovery-list">
                {frame?.recoveries.length ? (
                  frame.recoveries.slice(-6).map((r) => (
                    <li key={r.id}>
                      <strong>
                        {r.linkId}{" "}
                        <small>{(r.failureUs / SECOND).toFixed(3)}초</small>
                      </strong>
                      <span>
                        {r.status === "unaffected"
                          ? "영향 없음"
                          : r.status === "recovered"
                            ? `${(r.recoveryUs! / 1000).toFixed(3)} ms`
                            : r.status === "unrecovered"
                              ? "미복구"
                              : r.detectedUs === null
                                ? "감지 대기"
                                : "경로 수립 중"}
                      </span>
                      <small>
                        감지{" "}
                        {r.detectionUs === null
                          ? "—"
                          : `${(r.detectionUs / 1000).toFixed(3)} ms`}{" "}
                        · 인지 후 수립{" "}
                        {r.establishmentUs === null
                          ? "—"
                          : `${(r.establishmentUs / 1000).toFixed(3)} ms`}
                      </small>
                    </li>
                  ))
                ) : (
                  <li>기록 없음</li>
                )}
              </ul>
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
            onClick={() => {
              if (simulation.ended) {
                jump(0);
                setPlaying(true);
              } else setPlaying((v) => !v);
            }}
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
            max={scenario.durationUs / SECOND}
            step="1"
            value={snapshot.seconds}
            onChange={(e) => jump(Number(e.target.value))}
          />
          <div className="time-ticks">
            {[0, 1, 2, 3, 4].map((i) => {
              const seconds = Math.round(
                ((scenario.durationUs / SECOND) * i) / 4,
              );
              const hours = scenario.durationUs >= 3600 * SECOND;
              const major = Math.floor(seconds / (hours ? 3600 : 60));
              const minor = hours ? Math.floor(seconds / 60) % 60 : seconds % 60;
              return (
                <span key={i}>
                  +{String(major).padStart(2, "0")}:{String(minor).padStart(2, "0")}
                </span>
              );
            })}
          </div>
        </div>
        <span className="run-status">
          {simulation.busy
            ? "계산 중"
            : simulation.ended
              ? "종료"
              : playing
                ? "재생 중"
                : "일시정지"}
        </span>
      </footer>
      {(error || simulation.error) && (
        <div className="error-banner" role="alert">
          <span>{error || simulation.error}</span>
          <button
            onClick={() => {
              setError("");
              simulation.clearError();
            }}
            aria-label="오류 닫기"
          >
            ×
          </button>
        </div>
      )}
    </main>
  );
}
