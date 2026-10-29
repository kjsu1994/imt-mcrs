import { groundLabel } from "./groundPresentation";
import { useEffect, useState } from "react";
import { defaultGround } from "./ground";
import type { GroundSettings } from "./ground";
import type { SimulationFrame } from "./engine";
const reason = {
  access: "지상 접속 불가",
  handover: "접속 전환·경로 수립",
  isl: "위성망 경로 불가",
};
export default function GroundPanel({
  settings,
  frame,
  onChange,
}: {
  settings: GroundSettings | null;
  frame: SimulationFrame | null;
  onChange: (settings: GroundSettings | null) => void;
}) {
  const [draft, setDraft] = useState(settings ?? defaultGround());
  useEffect(() => setDraft(settings ?? defaultGround()), [settings]);
  const view = frame?.ground,
    service = frame?.groundService;
  return (
    <div className="ground-panel" aria-label="지상 통신 설정">
      <label className="field">
        통신 끝점
        <select
          aria-label="통신 끝점"
          value={settings ? "ground" : "satellite"}
          onChange={(e) =>
            onChange(e.target.value === "ground" ? defaultGround() : null)
          }
        >
          <option value="satellite">위성 ↔ 위성</option>
          <option value="ground">지상국(GS) → 사용자 단말(UT)</option>
        </select>
      </label>
      {settings && (
        <>
          <p className="model-caption">
            지구 표면 우클릭으로 GS·UT 지정 · 위치·설정 적용 시 새 실험
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              onChange(draft);
            }}
          >
            {(["ut", "gs"] as const).map((role) => (
              <fieldset className="ground-endpoint" key={role}>
                <legend>
                  {role === "ut" ? "송신 지상국 GS" : "목적지 사용자 단말 UT"}
                </legend>
                <div className="field-grid">
                  {(["latitude", "longitude"] as const).map((key) => (
                    <label className="field" key={key}>
                      {key === "latitude" ? "위도" : "경도"}
                      <input
                        type="number"
                        step="any"
                        min={key === "latitude" ? -90 : -180}
                        max={key === "latitude" ? 90 : 180}
                        aria-label={`${groundLabel(role)} ${key === "latitude" ? "위도" : "경도"}`}
                        value={
                          Number.isNaN(draft[role]?.[key])
                            ? ""
                            : (draft[role]?.[key] ?? "")
                        }
                        placeholder="미지정"
                        onChange={(e) =>
                          setDraft((d) => ({
                            ...d,
                            [role]: {
                              ...(d[role] ?? { latitude: 0, longitude: 0 }),
                              [key]:
                                e.target.value === ""
                                  ? NaN
                                  : Number(e.target.value),
                            },
                          }))
                        }
                      />
                    </label>
                  ))}
                </div>
                <p
                  className="model-caption"
                  aria-label={`${groundLabel(role)} 접속 상태`}
                >
                  {!settings[role]
                    ? "위치 미지정"
                    : view?.[role].satelliteId == null
                      ? "접속 가능한 위성 없음"
                      : `위성 ${view[role].satelliteId} · 고각 ${view[role].elevationDeg?.toFixed(1)}° · ${view[role].ready ? "접속" : "전환 중"}`}
                </p>
                <button
                  type="button"
                  disabled={!settings[role]}
                  onClick={() => onChange({ ...settings, [role]: null })}
                >
                  {groundLabel(role)} 삭제
                </button>
              </fieldset>
            ))}
            <div className="field-grid">
              <label className="field">
                최소 고각 (°)
                <input
                  aria-label="최소 고각"
                  type="number"
                  min="0"
                  max="90"
                  step="any"
                  value={
                    Number.isNaN(draft.minimumElevationDeg)
                      ? ""
                      : draft.minimumElevationDeg
                  }
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      minimumElevationDeg:
                        e.target.value === "" ? NaN : Number(e.target.value),
                    }))
                  }
                />
              </label>
              <label className="field">
                접속 전환 지연 (ms)
                <input
                  aria-label="접속 전환 지연"
                  type="number"
                  min="0"
                  max="60000"
                  step="0.001"
                  value={
                    Number.isNaN(draft.handoverDelayUs)
                      ? ""
                      : draft.handoverDelayUs / 1000
                  }
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      handoverDelayUs:
                        e.target.value === ""
                          ? NaN
                          : Math.round(Number(e.target.value) * 1000),
                    }))
                  }
                />
              </label>
            </div>
            <button className="secondary" type="submit">
              지상 설정 적용
            </button>
          </form>
          <p className="ground-status" aria-label="지상 서비스 상태">
            {view?.available
              ? "GS → 위성망 → UT 연결"
              : !view ||
                  view.ut.satelliteId === null ||
                  view.gs.satelliteId === null
                ? "지상 접속 대기"
                : !view.ut.ready || !view.gs.ready || view.routePending
                  ? "접속 전환·경로 수립 중"
                  : "위성망 경로 없음"}
          </p>
          <dl className="service-summary" aria-label="지상 종단 간 지표">
            <div>
              <dt>종단 간 가용률</dt>
              <dd>
                {service?.availability == null
                  ? "—"
                  : `${(service.availability * 100).toFixed(4)}%`}
              </dd>
            </div>
            <div>
              <dt>종단 간 전파 지연</dt>
              <dd>
                {frame?.groundPropagationDelayMs == null
                  ? "—"
                  : `${frame.groundPropagationDelayMs.toFixed(2)} ms`}
              </dd>
            </div>
            <div>
              <dt>서비스 중단</dt>
              <dd>{service?.outageCount ?? 0}회</dd>
            </div>
            <div>
              <dt>지상 접속 불가</dt>
              <dd>{((service?.accessDowntimeUs ?? 0) / 1000).toFixed(3)} ms</dd>
            </div>
            <div>
              <dt>접속 전환·경로 수립</dt>
              <dd>
                {((service?.handoverDowntimeUs ?? 0) / 1000).toFixed(3)} ms
              </dd>
            </div>
            <div>
              <dt>위성망 경로 불가</dt>
              <dd>{((service?.islDowntimeUs ?? 0) / 1000).toFixed(3)} ms</dd>
            </div>
          </dl>
          <details>
            <summary>지상 접속·중단 이력</summary>
            <ol className="event-list">
              {frame?.groundAccessEvents?.map((e, i) => (
                <li key={i}>
                  {(e.atUs / 1000000).toFixed(3)}초 · {groundLabel(e.role)} ·{" "}
                  {e.from ?? "미접속"} → {e.to ?? "미접속"}
                </li>
              ))}
            </ol>
            <ol className="event-list">
              {service?.outages.map((o, i) => (
                <li key={i}>
                  {(o.startedUs / 1000000).toFixed(3)}초 ·{" "}
                  {o.recoveredUs === null
                    ? "중단 중"
                    : `${((o.recoveredUs - o.startedUs) / 1000).toFixed(3)} ms`}{" "}
                  · {o.causes.map((c) => reason[c]).join(" → ")}
                </li>
              ))}
            </ol>
          </details>
        </>
      )}
    </div>
  );
}
