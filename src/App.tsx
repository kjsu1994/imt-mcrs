import { useState, useMemo, useEffect } from "react";
import Globe from "./Globe";
import type { Telemetry } from "./Globe";
import { PRESETS, validate, period, mesh } from "./model";
import {
  createScenario,
  normalizeScenario,
  validateScenario,
  SECOND,
  edgeId,
  DEFAULT_EPOCH_MS,
} from "./engine";
import type { Scenario } from "./engine";
import type { RoutingSettings } from "./routing";
import { useSimulation } from "./useSimulation";
const initial: Telemetry = { latitude: 0, longitude: 0, altitude: 0 };
const defaultExperiment = {
  durationSeconds: 86400,
  slsMs: 100,
  computeMs: 1,
  installMs: 1,
  seed: 1,
  notificationMs: 0,
  switchMs: 0,
};
export default function App() {
  const [config, setConfig] = useState(PRESETS[0].config),
    [draft, setDraft] = useState(config),
    [startMs, setStartMs] = useState(DEFAULT_EPOCH_MS),
    [utcDraft, setUtcDraft] = useState(
      new Date(DEFAULT_EPOCH_MS).toISOString().slice(0, 19),
    ),
    [loadedScenario, setLoadedScenario] = useState<Scenario | null>(null),
    [previewId, setPreviewId] = useState(""),
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
    () =>
      loadedScenario ?? {
        ...createScenario(config, startMs, source, target),
        durationUs: Math.round(experiment.durationSeconds * SECOND),
        slsIntervalUs: Math.round(experiment.slsMs * 1000),
        computeDelayUs: Math.round(experiment.computeMs * 1000),
        installDelayUs: Math.round(experiment.installMs * 1000),
        notificationDelayUs: Math.round(experiment.notificationMs * 1000),
        switchDelayUs: Math.round(experiment.switchMs * 1000),
        seed: experiment.seed,
      },
    [loadedScenario, config, startMs, source, target, experiment],
  );
  const simulation = useSimulation(scenario, playing, speed);
  useEffect(() => {
    if (simulation.ended) setPlaying(false);
  }, [simulation.ended]);
  const frame = simulation.frame;
  const preview = frame?.routingAnalysis.candidates.find(
    (c) => c.id === previewId,
  );
  useEffect(() => setPreviewId(""), [scenario]);
  function updateRouting(routing: RoutingSettings) {
    setLoadedScenario({
      ...structuredClone(frame?.scenario ?? scenario),
      routing,
    });
  }
  async function importScenario(file: File) {
    try {
      if (file.size > 10 * 1024 * 1024)
        throw new Error("JSON은 10MB 이하여야 합니다.");
      const raw = JSON.parse(await file.text());
      const next = normalizeScenario(raw?.scenario ?? raw);
      const experiment = {
        durationSeconds: next.durationUs / SECOND,
        slsMs: next.slsIntervalUs / 1000,
        computeMs: next.computeDelayUs / 1000,
        installMs: next.installDelayUs / 1000,
        seed: next.seed,
        notificationMs: next.notificationDelayUs / 1000,
        switchMs: next.switchDelayUs / 1000,
      };
      setConfig(next.config);
      setDraft(next.config);
      setStartMs(next.epochMs);
      setUtcDraft(new Date(next.epochMs).toISOString().slice(0, 19));
      setExperiment(experiment);
      setExperimentDraft(experiment);
      setSource(next.source);
      setTarget(next.target);
      setSelected(null);
      setTracking(false);
      setPlaying(false);
      setHome((v) => v + 1);
      setLoadedScenario(next);
      setInputError("");
    } catch (e) {
      setInputError(e instanceof Error ? e.message : String(e));
    }
  }
  function endpoint(source: number, target: number) {
    setSource(source);
    setTarget(target);
    setLoadedScenario(null);
    setPreviewId("");
  }
  const snapshot = {
    ...telemetry,
    seconds: (frame?.timeUs ?? 0) / SECOND,
    path: frame?.path ?? [],
    length: frame?.length ?? 0,
    links: frame?.physicalLinkCount ?? 0,
  };
  const draftPreset = PRESETS.findIndex((p) =>
    (["planes", "perPlane", "altitude", "inclination", "phase"] as const).every(
      (key) => p.config[key] === draft[key],
    ),
  );
  const edgeOptions = useMemo(
    () => mesh(config).map(([a, b]) => edgeId(a, b)),
    [config],
  );
  const linkOptions = useMemo(
    () =>
      edgeOptions.map((id) => (
        <option key={id} value={id}>
          {id.replace(":", " ↔ ")}
        </option>
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
      const epochMs = Date.parse(utcDraft + "Z");
      validateScenario({
        ...scenario,
        epochMs,
        durationUs: Math.round(experimentDraft.durationSeconds * SECOND),
        slsIntervalUs: Math.round(experimentDraft.slsMs * 1000),
        computeDelayUs: Math.round(experimentDraft.computeMs * 1000),
        installDelayUs: Math.round(experimentDraft.installMs * 1000),
        seed: experimentDraft.seed,
        notificationDelayUs: Math.round(experimentDraft.notificationMs * 1000),
        switchDelayUs: Math.round(experimentDraft.switchMs * 1000),
      });
      if (loadedScenario)
        setLoadedScenario({
          ...scenario,
          epochMs,
          durationUs: Math.round(experimentDraft.durationSeconds * SECOND),
          slsIntervalUs: Math.round(experimentDraft.slsMs * 1000),
          computeDelayUs: Math.round(experimentDraft.computeMs * 1000),
          installDelayUs: Math.round(experimentDraft.installMs * 1000),
          seed: experimentDraft.seed,
          notificationDelayUs: Math.round(
            experimentDraft.notificationMs * 1000,
          ),
          switchDelayUs: Math.round(experimentDraft.switchMs * 1000),
        });
      setStartMs(epochMs);
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
    setLoadedScenario(null);
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
                value={String(draftPreset)}
                onChange={(e) =>
                  setDraft({ ...PRESETS[Number(e.target.value)].config })
                }
              >
                <option value="-1" disabled>
                  사용자 설정
                </option>
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
              <label className="field">
                시작 UTC
                <input
                  aria-label="시작 UTC"
                  type="datetime-local"
                  step="1"
                  value={utcDraft}
                  onChange={(e) => setUtcDraft(e.target.value)}
                />
              </label>
              <div className="field-grid">
                {(
                  [
                    ["durationSeconds", "실험 길이", "초"],
                    ["slsMs", "SLS 간격", "ms"],
                    ["computeMs", "계산 지연", "ms"],
                    ["installMs", "설치 지연", "ms"],
                    ["notificationMs", "통지 지연", "ms"],
                    ["switchMs", "예비 전환 지연", "ms"],
                    ["seed", "시드", ""],
                  ] as const
                ).map(([key, label, unit]) => (
                  <label key={key} className="field">
                    {label}
                    <div className="input-unit">
                      <input
                        type="number"
                        aria-label={label}
                        disabled={key === "seed"}
                        title={
                          key === "seed"
                            ? "예약값 · 현재 난수 생성 미사용"
                            : undefined
                        }
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
              <label className="field">
                시나리오 가져오기
                <input
                  type="file"
                  accept=".json,application/json"
                  aria-label="시나리오 가져오기"
                  onChange={(e) => {
                    const input = e.currentTarget;
                    const file = input.files?.[0];
                    if (file)
                      void importScenario(file).finally(() => {
                        input.value = "";
                      });
                  }}
                />
              </label>
              <label className="field">
                라우팅 알고리즘
                <select
                  aria-label="라우팅 알고리즘"
                  value={scenario.routing.algorithm}
                  onChange={(e) =>
                    updateRouting({
                      ...scenario.routing,
                      algorithm: e.target.value as RoutingSettings["algorithm"],
                    })
                  }
                >
                  <option value="bfs">BFS · 최단 홉</option>
                  <option value="candidate-paths">
                    수동 후보 · MCSR 미적용
                  </option>
                </select>
              </label>
              <label className="field">
                서비스 유형
                <select
                  aria-label="서비스 유형"
                  value={scenario.routing.service}
                  onChange={(e) =>
                    updateRouting({
                      ...scenario.routing,
                      service: e.target.value as RoutingSettings["service"],
                    })
                  }
                >
                  <option value="LS">LS · 지연 우선</option>
                  <option value="TS">TS · 가용 버퍼 우선</option>
                  <option value="HR">HR · J &lt; 15ms, 버퍼 우선</option>
                </select>
              </label>
              <p className="model-caption">
                SLS 3회 누락 감지 · 설정 지연 모델
                <br />
                시드 예약값 · 현재 난수 생성 미사용
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
              topology={simulation.topology}
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
              previewPath={preview?.nodes ?? []}
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
                    onChange={(e) => endpoint(Number(e.target.value), target)}
                  >
                    {nodes}
                  </select>
                </label>
                <button
                  disabled={selected === null}
                  title="선택 위성을 출발 노드로"
                  aria-label="선택 위성을 출발 노드로"
                  onClick={() =>
                    selected !== null && endpoint(selected, target)
                  }
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
                    onChange={(e) => endpoint(source, Number(e.target.value))}
                  >
                    {nodes}
                  </select>
                </label>
                <button
                  disabled={selected === null}
                  title="선택 위성을 도착 노드로"
                  aria-label="선택 위성을 도착 노드로"
                  onClick={() =>
                    selected !== null && endpoint(source, selected)
                  }
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
              <dl
                className="link-metrics"
                aria-label="현재 경로 속성"
                title="논리 시각 기준. 버퍼는 설정된 큐 상태, 지터는 가상 입력입니다."
              >
                <div>
                  <dt>전파 지연</dt>
                  <dd>
                    {frame?.currentPathMetrics?.candidate
                      ? `${frame?.currentPathMetrics.candidate.propagationDelayMs.toFixed(2)} ms`
                      : "—"}
                  </dd>
                </div>
                <div>
                  <dt>가용 버퍼</dt>
                  <dd>
                    {frame?.currentPathMetrics?.candidate
                      ? `${(frame?.currentPathMetrics.candidate.availableBufferRatio * 100).toFixed(1)} %`
                      : "—"}
                  </dd>
                </div>
                <div>
                  <dt>가상 지터</dt>
                  <dd>
                    {frame?.currentPathMetrics?.candidate
                      ? `${frame?.currentPathMetrics.candidate.jitterMs.toFixed(2)} ms`
                      : "—"}
                  </dd>
                </div>
              </dl>
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
                {frame?.routingAlgorithm === "BFS"
                  ? "최단 홉 · 시각화"
                  : "수동 후보 · 시각화"}
              </span>
            </section>
            <section
              className="panel-section routing-analysis"
              aria-label="라우팅 판단"
            >
              <h2>경로 후보</h2>
              <p className="model-caption">
                {frame
                  ? (
                      {
                        pending: "계산·설치 대기",
                        installed: "설치 완료",
                        retained: "기존 경로 유지",
                        discarded: "입력 변경으로 폐기",
                      } as const
                    )[frame.routingAnalysis.status]
                  : "대기"}
              </p>
              <p className="model-caption">
                {frame?.routingAnalysis.mode === "reserve"
                  ? "저장 후보 재사용"
                  : frame?.routingAnalysis.mode === "recalculate"
                    ? "후보 재계산"
                    : "초기 계산"}{" "}
                · {scenario.routing.service}
                {frame
                  ? ` · ${(frame.routingAnalysis.atUs / SECOND).toFixed(3)}초`
                  : ""}
              </p>
              {frame?.routingAnalysis.candidates.map((c) => (
                <button
                  className={
                    "candidate-row " + (previewId === c.id ? "active" : "")
                  }
                  key={c.id}
                  aria-pressed={previewId === c.id}
                  onClick={() => setPreviewId(previewId === c.id ? "" : c.id)}
                >
                  <strong>{c.nodes.join(" → ")}</strong>
                  <span>
                    {
                      (
                        {
                          selected: "선택",
                          eligible: "예비",
                          dominated: "속성 열위",
                          "jitter-limit": "지터 제한 초과",
                          unavailable: "링크 사용 불가",
                        } as const
                      )[c.status]
                    }
                  </span>
                  <small>
                    {c.metrics
                      ? `${c.metrics.propagationDelayMs.toFixed(2)} ms · ${(c.metrics.availableBufferRatio * 100).toFixed(1)}% · J ${c.metrics.jitterMs.toFixed(2)} ms`
                      : "—"}
                  </small>
                  <small>
                    {c.status === "selected"
                      ? `${scenario.routing.service} 선택 기준`
                      : c.status === "dominated"
                        ? `우세 후보 ${c.reason.replace("dominated by ", "").replaceAll(":", " → ")}`
                        : c.status === "jitter-limit"
                          ? "J < 15 ms 조건 불충족"
                          : c.status === "unavailable"
                            ? "인지된 링크 상태로 제외"
                            : "전환 가능 후보"}
                  </small>
                </button>
              ))}
              {!frame?.routingAnalysis.candidates.length && (
                <p className="model-caption">사용 가능한 후보 없음</p>
              )}
              <details className="routing-stages">
                <summary>복구·계산 단계</summary>
                <ol className="event-list">
                  {frame?.routingStages.map((e, i) => (
                    <li key={i}>
                      {(e.atUs / SECOND).toFixed(6)}초 ·{" "}
                      {(
                        {
                          "notification-started": "통지 시작",
                          "notification-completed": "통지 완료",
                          "notification-discarded": "통지 취소",
                          "route-decision": "후보 선택",
                          "route-started": "재계산 시작",
                          "route-computed": "재계산 완료",
                          "reserve-switch-started": "예비 전환 시작",
                          "reserve-switch-ready": "예비 전환 준비",
                          "route-install-started": "설치 시작",
                          "route-installed": "설치 완료",
                          "route-discarded": "작업 폐기",
                          "route-retained": "기존 경로 유지",
                          "link-detected-down": "장애 감지",
                          "link-detected-up": "복구 인지",
                        } as Record<string, string>
                      )[e.type] ?? e.type}
                    </li>
                  ))}
                </ol>
              </details>
              {preview && (
                <p className="model-caption">
                  파란 선: 검토 후보 · 설치 경로와 별도
                </p>
              )}
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
              <h3>서비스 중단</h3>
              <dl className="service-summary">
                <div>
                  <dt>중단 횟수</dt>
                  <dd>{frame?.outageCount ?? 0}회</dd>
                </div>
                <div>
                  <dt>누적 중단</dt>
                  <dd>
                    {((frame?.totalDowntimeUs ?? 0) / 1000).toFixed(3)} ms
                  </dd>
                </div>
                <div>
                  <dt>가용률</dt>
                  <dd>
                    {frame?.availability == null
                      ? "—"
                      : `${(frame.availability * 100).toFixed(4)}%`}
                  </dd>
                </div>
                <div>
                  <dt>복구 완료 평균</dt>
                  <dd>
                    {frame?.meanOutageUs == null
                      ? "—"
                      : `${(frame.meanOutageUs / 1000).toFixed(3)} ms`}
                  </dd>
                </div>
                <div>
                  <dt>미복구 / 진행 중</dt>
                  <dd>
                    {frame?.unrecoveredCount ?? 0} / {frame?.pendingCount ?? 0}
                  </dd>
                </div>
              </dl>
              <ul className="recovery-list">
                {frame?.serviceOutages.length ? (
                  frame.serviceOutages.map((r) => (
                    <li key={r.id}>
                      <strong>
                        중단 #{r.id}{" "}
                        <small>{(r.startedUs / SECOND).toFixed(3)}초</small>
                      </strong>
                      <span>
                        {r.status === "recovered"
                          ? `${(r.recoveryUs! / 1000).toFixed(3)} ms`
                          : r.status === "unrecovered"
                            ? "미복구"
                            : "중단 중"}
                      </span>
                      <small>
                        {r.reason === "initial-unreachable"
                          ? "초기 미연결"
                          : `관련 링크 ${r.causeLinkIds.join(", ") || "—"}`}
                      </small>
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
              <details className="link-history">
                <summary>링크 장애 이력 (최근 6건)</summary>
                <ol className="event-list">
                  {frame?.linkFailures.length ? (
                    frame.linkFailures.map((r) => (
                      <li key={r.id}>
                        {r.linkId} · 단절 {(r.startedUs / SECOND).toFixed(3)}초
                        <br />
                        감지{" "}
                        {r.detectedUs === null
                          ? "—"
                          : `${(r.detectedUs / SECOND).toFixed(3)}초`}{" "}
                        · 물리 복구{" "}
                        {r.restoredUs === null
                          ? "—"
                          : `${(r.restoredUs / SECOND).toFixed(3)}초`}
                      </li>
                    ))
                  ) : (
                    <li>기록 없음</li>
                  )}
                </ol>
              </details>
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
          <time title="논리 시각 기준입니다. 3D 화면은 약 0.1초 지연해 재생합니다.">
            {utc}
            <small> UTC</small>
          </time>
          <input
            aria-label="시뮬레이션 시간"
            type="range"
            min="0"
            max={scenario.durationUs / SECOND}
            step="0.001"
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
              const minor = hours
                ? Math.floor(seconds / 60) % 60
                : seconds % 60;
              return (
                <span key={i}>
                  +{String(major).padStart(2, "0")}:
                  {String(minor).padStart(2, "0")}
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
