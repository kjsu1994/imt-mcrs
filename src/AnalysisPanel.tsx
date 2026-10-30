import { memo, useMemo, useState } from "react";
import { validateComparison, repeatSummary } from "./analysis";
import type { AnalysisRun, AnalysisSample, ComparisonReport } from "./analysis";
import type { Scenario } from "./engine";
const fmt = (n: number | null | undefined, digits = 2) =>
  n == null
    ? "—"
    : n.toLocaleString("ko-KR", { maximumFractionDigits: digits });
const metricLabel = {
  delay: "ISL 전파 지연 (ms)",
  endToEnd: "종단 전파 지연 (ms)",
  hops: "ISL 홉 수",
  buffer: "가용 버퍼 비율",
  jitter: "모델 지터 (ms)",
};
type Metric = keyof typeof metricLabel;
const getValue = (s: AnalysisSample, key: Metric) =>
  !s.available
    ? null
    : key === "endToEnd"
      ? s.endToEndPropagationMs
      : key === "hops"
        ? s.hopCount
        : key === "delay"
          ? (s.metrics?.propagationDelayMs ?? null)
          : key === "buffer"
            ? (s.metrics?.availableBufferRatio ?? null)
            : (s.metrics?.jitterMs ?? null);
function Chart({
  runs,
  metric,
  atUs,
  setAt,
}: {
  runs: AnalysisRun[];
  metric: Metric;
  atUs: number;
  setAt: (n: number) => void;
}) {
  const duration = runs[0]?.scenario.durationUs ?? 1;
  const graph = useMemo(() => {
    let max = 0;
    const lines = runs.map((run) => {
      // Retain each bucket's extrema and gaps; full samples remain in the report.
      const points: { time: number; value: number | null }[] = [];
      const bucketSize = Math.max(1, Math.ceil(run.samples.length / 250));
      for (let i = 0; i < run.samples.length; i += bucketSize) {
        const bucket = run.samples
          .slice(i, i + bucketSize)
          .map((s) => ({ time: s.timeUs, value: getValue(s, metric) }));
        const values = bucket.filter((p) => p.value !== null);
        const keep = new Set([
          bucket[0],
          bucket.at(-1)!,
          bucket.find((p) => p.value === null),
          values.reduce<(typeof bucket)[number] | undefined>(
            (a, p) => (!a || p.value! < a.value! ? p : a),
            undefined,
          ),
          values.reduce<(typeof bucket)[number] | undefined>(
            (a, p) => (!a || p.value! > a.value! ? p : a),
            undefined,
          ),
        ]);
        for (const point of bucket)
          if (keep.has(point)) {
            points.push(point);
            max = Math.max(max, point.value ?? 0);
          }
      }
      return { run, points };
    });
    const top = max || 1;
    return {
      top,
      lines: lines.map(({ run, points }) => {
        let down = false,
          d = "";
        for (const p of points) {
          if (p.value === null) {
            down = false;
            continue;
          }
          d += `${down ? "L" : "M"}${(28 + (p.time / duration) * 280).toFixed(2)},${(82 - (p.value / top) * 65).toFixed(2)} `;
          down = true;
        }
        return { id: run.id, algorithm: run.algorithm, d };
      }),
    };
  }, [runs, metric, duration]);
  return (
    <figure className="analysis-chart">
      <figcaption>{metricLabel[metric]}</figcaption>
      <svg
        viewBox="0 0 320 110"
        role="img"
        aria-label={metricLabel[metric]}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          setAt(
            Math.round(
              Math.max(
                0,
                Math.min(
                  1,
                  (((e.clientX - rect.left) / rect.width) * 320 - 28) / 280,
                ),
              ) * duration,
            ),
          );
        }}
      >
        <text x="2" y="12">
          {fmt(graph.top)}
        </text>
        <path d="M28,17 V82 H308" className="analysis-axis" />
        {runs.flatMap((run) =>
          run.outages
            .filter(
              (o) =>
                o.scope === (run.scenario.ground ? "ground" : "isl") &&
                o.durationUs > 0,
            )
            .map((o) => (
              <rect
                key={`${run.id}:${o.scope}:${o.id}`}
                x={28 + (o.startedUs / duration) * 280}
                y="17"
                width={Math.max(
                  0.5,
                  (((o.recoveredUs ?? o.censoredUs ?? duration) - o.startedUs) /
                    duration) *
                    280,
                )}
                height="65"
                fill={run.algorithm === "bfs" ? "#76b8ff" : "#80efbb"}
                opacity="0.12"
              >
                <title>
                  {run.algorithm.toUpperCase()} 중단 {fmt(o.startedUs / 1e6, 6)}
                  s
                </title>
              </rect>
            )),
        )}
        {graph.lines.map((l) => (
          <path key={l.id} d={l.d} className={`analysis-line ${l.algorithm}`} />
        ))}
        <path
          d={`M${28 + (atUs / duration) * 280},17 V82`}
          className="analysis-cursor"
        />
        <text x="28" y="103">
          0s
        </text>
        <text x="308" y="103" textAnchor="end">
          {fmt(duration / 1e6)}s
        </text>
      </svg>
    </figure>
  );
}
function AnalysisPanel({
  onReplay,
}: {
  onReplay: (scenario: Scenario, atUs: number) => void;
}) {
  const [report, setReport] = useState<ComparisonReport | null>(null),
    [error, setError] = useState(""),
    [service, setService] = useState("LS"),
    [repetition, setRepetition] = useState(1),
    [algorithm, setAlgorithm] = useState("mcsr"),
    [atUs, setAt] = useState(0),
    [page, setPage] = useState(0);
  const runs = useMemo(
    () =>
      report?.runs.filter(
        (r) => r.service === service && r.repetition === repetition,
      ) ?? [],
    [report, service, repetition],
  );
  const selected = runs.find((r) => r.algorithm === algorithm) ?? runs[0];
  const groups = useMemo(() => repeatSummary(report?.runs ?? []), [report]);
  const decision = selected?.decisions.filter((d) => d.atUs <= atUs).at(-1);
  async function load(file: File) {
    try {
      // shortcut: import is capped at 20 MB; use a Worker parser for larger reports.
      if (file.size > 20 * 1024 * 1024)
        throw new Error("비교 보고서는 20MB 이하여야 합니다.");
      const next = validateComparison(JSON.parse(await file.text()));
      setReport(next);
      setService(next.runs[0].service);
      setRepetition(next.runs[0].repetition);
      setAt(0);
      setPage(0);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  const metrics: [string, (r: AnalysisRun) => string][] = [
    [
      "종단 가용률",
      (r) =>
        fmt(
          r.summary!.availability == null
            ? null
            : r.summary!.availability * 100,
        ) + " %",
    ],
    [
      "중단 / 미복구",
      (r) => `${r.summary!.outageCount} / ${r.summary!.unrecoveredCount}`,
    ],
    ["총 중단 (ms)", (r) => fmt(r.summary!.totalDowntimeUs / 1000)],
    [
      "평균 완료 중단 (ms)",
      (r) =>
        fmt(
          r.summary!.recoveryUs.mean == null
            ? null
            : r.summary!.recoveryUs.mean / 1000,
        ),
    ],
    [
      "완료 중단 p95 (ms)",
      (r) =>
        fmt(
          r.summary!.recoveryUs.p95 == null
            ? null
            : r.summary!.recoveryUs.p95 / 1000,
        ),
    ],
    [
      "ISL 예비 복구 평균 (ms)",
      (r) =>
        fmt(
          r.summary!.reserveRecoveryUs.mean == null
            ? null
            : r.summary!.reserveRecoveryUs.mean / 1000,
        ),
    ],
    [
      "ISL 재계산 복구 평균 (ms)",
      (r) =>
        fmt(
          r.summary!.recalculationRecoveryUs.mean == null
            ? null
            : r.summary!.recalculationRecoveryUs.mean / 1000,
        ),
    ],
    [
      "ISL 물리 복원 평균 (ms)",
      (r) =>
        fmt(
          r.summary!.physicalRecoveryUs.mean == null
            ? null
            : r.summary!.physicalRecoveryUs.mean / 1000,
        ),
    ],
    ["평균 ISL 전파 (ms)", (r) => fmt(r.summary!.delay.mean)],
    [
      "유효 D/A/J 표본",
      (r) => `${r.summary!.delay.count} / ${r.samples.length}`,
    ],
    ["평균 ISL 홉", (r) => fmt(r.summary!.hops.mean)],
    ["평균 전파 (ms)", (r) => fmt(r.summary!.endToEndPropagation.mean)],
    [
      "평균 A / J (ms)",
      (r) =>
        `${fmt(r.summary!.buffer.mean, 3)} / ${fmt(r.summary!.jitter.mean)}`,
    ],
    ["ISL 관측 종료", (r) => String(r.summary!.censoredCount)],
    [
      "재계산 / 예비 설치",
      (r) => `${r.summary!.recalculations} / ${r.summary!.reserveInstalls}`,
    ],
    [
      "경로 변경 / 폐기",
      (r) => `${r.summary!.pathSwitches} / ${r.summary!.discarded}`,
    ],
    [
      "연산 / 전체 (ms)",
      (r) => `${fmt(r.performance.routingMs)} / ${fmt(r.performance.wallMs)}`,
    ],
    ["표본 수집 (ms)", (r) => fmt(r.performance.samplingMs)],
    [
      "전역 확장 / 제한 제외",
      (r) =>
        `${fmt(r.summary!.expandedStates, 0)} / ${fmt(r.summary!.boundedPruned, 0)}`,
    ],
    [
      "CSIB / ACK / 재전송",
      (r) =>
        r.control
          ? `${r.control.sentUpdates} / ${r.control.sentAcks} / ${r.control.retries}`
          : r.algorithm === "mcsr"
            ? "고정 통지 · ACK 미모델링"
            : "모델 해당 없음",
    ],
  ];
  return (
    <details className="analysis-panel">
      <summary>실험 분석 · BFS / MCSR</summary>
      <label className="field">
        비교 보고서 가져오기
        <input
          type="file"
          accept=".json,application/json"
          aria-label="비교 보고서 가져오기"
          onChange={(e) => {
            const input = e.currentTarget,
              file = input.files?.[0];
            if (file)
              void load(file).finally(() => {
                input.value = "";
              });
          }}
        />
      </label>
      {error && <p role="alert">{error}</p>}
      {!report ? (
        <p>analyze:compare로 생성한 comparison.json을 불러오세요.</p>
      ) : (
        <>
          <p aria-label="분석 보고서 조건">
            보고서:{" "}
            {fmt(
              (selected?.scenario.config.planes ?? 0) *
                (selected?.scenario.config.perPlane ?? 0),
              0,
            )}
            기 · {fmt((selected?.scenario.durationUs ?? 0) / 1e6)}초 ·{" "}
            {selected?.scenario.ground ? "GS → UT" : "위성 간"}
          </p>
          <p className="analysis-note">
            BFS: 전역 인지 · MCSR: 영역별 수신 CSIB. 정보·제어 모델이 다릅니다.
            전파 지연과 입력 A/J를 비교하며 실제 패킷 지연·손실·처리량은
            측정하지 않습니다.
          </p>
          <div className="button-row">
            <label>
              서비스
              <select
                aria-label="분석 서비스"
                value={service}
                onChange={(e) => {
                  setService(e.target.value);
                  setRepetition(
                    report.runs.find((r) => r.service === e.target.value)!
                      .repetition,
                  );
                  setPage(0);
                }}
              >
                {[...new Set(report.runs.map((r) => r.service))].map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </label>
            <label>
              반복
              <select
                aria-label="분석 반복"
                value={repetition}
                onChange={(e) => {
                  setRepetition(Number(e.target.value));
                  setPage(0);
                }}
              >
                {[
                  ...new Set(
                    report.runs
                      .filter((r) => r.service === service)
                      .map((r) => r.repetition),
                  ),
                ].map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="analysis-scroll">
            <table aria-label="알고리즘 비교">
              <thead>
                <tr>
                  <th>지표</th>
                  {runs.map((r) => (
                    <th key={r.id} className={r.algorithm}>
                      {r.algorithm.toUpperCase()}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th>실행 상태</th>
                  {runs.map((r) => (
                    <td key={r.id}>
                      {r.status === "completed" ? "완료" : `실패: ${r.error}`}
                    </td>
                  ))}
                </tr>
                {metrics.map(([label, value]) => (
                  <tr key={label}>
                    <th>{label}</th>
                    {runs.map((r) => (
                      <td key={r.id}>
                        {r.status === "completed" && r.summary ? value(r) : "—"}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <details>
            <summary>반복 실행·모델 조건</summary>
            {groups
              .filter((g) => g.key.endsWith(":" + service))
              .map((g) => (
                <p key={g.key}>
                  {g.key} · 성공 {g.completed} / 실패 {g.failed} · 실행 중앙값{" "}
                  {fmt(g.wallMs.median)}ms ({fmt(g.wallMs.min)}~
                  {fmt(g.wallMs.max)}) · 반복 논리 결과{" "}
                  {g.logicalMatch === null
                    ? "미확인"
                    : g.logicalMatch
                      ? "일치"
                      : "불일치"}
                </p>
              ))}
            <p>
              표본 {fmt(report.sampleIntervalUs / 1e6)}초 · 평균은 가용 표본만
              포함 · 중단은 사건 기반 집계. 탐색 제한은 입력 시나리오 그대로
              적용하며 전역 최적성을 보장하지 않습니다.
            </p>
            <pre>{JSON.stringify(report.metadata, null, 2)}</pre>
          </details>
          <p className="analysis-legend">
            <span className="bfs">BFS</span> /{" "}
            <span className="mcsr">MCSR</span> · 음영은 서비스 중단 · 그래프를
            눌러 시각 선택
          </p>
          {(["endToEnd", "hops", "buffer", "jitter"] as Metric[]).map(
            (metric) => (
              <Chart
                key={metric}
                runs={runs}
                metric={metric}
                atUs={atUs}
                setAt={setAt}
              />
            ),
          )}
          <label className="field">
            분석 시각 (초)
            <input
              type="number"
              aria-label="분석 시각"
              min="0"
              max={(selected?.scenario.durationUs ?? 0) / 1e6}
              step="0.001"
              value={atUs / 1e6}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n))
                  setAt(
                    Math.max(
                      0,
                      Math.min(
                        selected?.scenario.durationUs ?? 0,
                        Math.round(n * 1e6),
                      ),
                    ),
                  );
              }}
            />
          </label>
          <div className="button-row">
            <select
              aria-label="분석 재생 알고리즘"
              value={selected?.algorithm ?? algorithm}
              onChange={(e) => {
                setAlgorithm(e.target.value);
                setPage(0);
              }}
            >
              {runs.map((r) => (
                <option key={r.id} value={r.algorithm}>
                  {r.algorithm.toUpperCase()}
                </option>
              ))}
            </select>
            <button
              disabled={!selected || selected.status !== "completed"}
              onClick={() =>
                onReplay(structuredClone(selected!.scenario), atUs)
              }
            >
              이 시점 3D 재생
            </button>
          </div>
          {selected && (
            <>
              {selected.summary && (
                <p>
                  접속 불가{" "}
                  {fmt((selected.summary.accessDowntimeUs ?? 0) / 1000)}ms ·
                  핸드오버{" "}
                  {fmt((selected.summary.handoverDowntimeUs ?? 0) / 1000)}ms ·
                  ISL 중단 {fmt((selected.summary.islDowntimeUs ?? 0) / 1000)}ms
                  · 생략된 상세 제어 기록 {selected.summary.traceOmitted}건
                </p>
              )}
              {decision && (
                <p>
                  판단 {decision.id} · {decision.mode} / {decision.status} ·{" "}
                  {decision.trigger}
                  <br />
                  선택 {decision.selectedId ?? "없음"} · 후보{" "}
                  {decision.candidateCount}개<br />
                  선택 규칙:{" "}
                  {service === "LS"
                    ? "지연 최소 → 버퍼 최대 → 지터 최소"
                    : service === "TS"
                      ? "버퍼 최대 → 지연 최소 → 지터 최소"
                      : "J < 15ms 충족 후 버퍼 최대 → 지연 최소 → 지터 최소"}
                  <br />
                  {decision.selected?.metrics &&
                    `계산 당시 D ${fmt(decision.selected.metrics.propagationDelayMs)}ms · A ${fmt(decision.selected.metrics.availableBufferRatio, 3)} · J ${fmt(decision.selected.metrics.jitterMs)}ms`}
                  <br />
                  {decision.selected?.reason ?? ""} ·{" "}
                  {JSON.stringify(decision.reasons)}
                </p>
              )}
              {decision?.search && (
                <details>
                  <summary>탐색 제한·제외 근거</summary>
                  <p>
                    로컬 수치는 사용한 캐시 요약의 참조량이며 실제 누적 연산량이
                    아닙니다. 제외 사례는 저장된 일부만 표시합니다.
                  </p>
                  <pre>{JSON.stringify(decision.search, null, 2)}</pre>
                </details>
              )}
              <details>
                <summary>중단·복구 이력 ({selected.outages.length})</summary>
                {selected.outages.slice(page * 20, page * 20 + 20).map((o) => (
                  <p key={`${o.scope}:${o.id}`}>
                    <button onClick={() => setAt(o.startedUs)}>
                      {o.scope} #{o.id} · {fmt(o.startedUs / 1e6, 6)}s
                    </button>{" "}
                    →{" "}
                    {o.recoveredUs === null
                      ? o.status
                      : fmt(o.recoveredUs / 1e6, 6) + "s"}
                    <br />
                    {fmt(o.durationUs / 1000)}ms · {o.mechanism ?? "—"}
                    <br />
                    감지{" "}
                    {fmt(o.detectedUs === null ? null : o.detectedUs / 1e6, 6)}s
                    · 출발 영역 인지{" "}
                    {fmt(
                      o.sourceInformedUs === null
                        ? null
                        : o.sourceInformedUs / 1e6,
                      6,
                    )}
                    s<br />
                    {o.causes.join(", ")}
                  </p>
                ))}
                <div className="button-row">
                  <button
                    disabled={page === 0}
                    onClick={() => setPage((p) => p - 1)}
                  >
                    이전 중단
                  </button>
                  <button
                    disabled={(page + 1) * 20 >= selected.outages.length}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    다음 중단
                  </button>
                </div>
              </details>
              <details>
                <summary>선택 시각의 복구·계산 단계</summary>
                {selected.stages
                  .filter((e) => e.atUs <= atUs)
                  .slice(-20)
                  .map((e, i) => (
                    <p key={i}>
                      <button onClick={() => setAt(e.atUs)}>
                        {fmt(e.atUs / 1e6, 6)}s
                      </button>{" "}
                      {e.type} {e.reason ?? ""}
                      {"decisionId" in e ? ` · 판단 ${e.decisionId}` : ""}
                    </p>
                  ))}
              </details>
            </>
          )}
        </>
      )}
    </details>
  );
}
export default memo(AnalysisPanel);
