// Onglet Progression (issue #61) : séries calculées à la lecture par GET /api/progression
// (historique importé + 7 jours de l'API), en six graphiques SVG maison.

import { useEffect, useState } from "react";
import type {
  Grouping,
  Period,
  ProgressionBucket,
  ProgressionResponse,
} from "../core/progression";
import { RouteLink } from "./AppNav";
import { BarChart, LineChart, type ChartPoint } from "./charts/Chart";
import {
  bucketLabel,
  bucketPeriod,
  tableDate,
  describeSeries,
  formatHoursMinutes,
  GROUP_OPTIONS,
  PERIOD_OPTIONS,
  SERIES,
  completePeriods,
  staleMessage,
  type Series,
} from "./progression";
import { Alert, Loading } from "./ui";

type State =
  | { status: "loading" }
  | { status: "loaded"; data: ProgressionResponse }
  | { status: "failed" };

async function loadProgression(
  period: Period,
  group: Grouping,
): Promise<State> {
  try {
    const response = await fetch(
      `/api/progression?period=${period}&group=${group}`,
    );
    if (!response.ok) return { status: "failed" };
    return {
      status: "loaded",
      data: (await response.json()) as ProgressionResponse,
    };
  } catch {
    return { status: "failed" };
  }
}

type ChoiceProps<T extends string> = {
  legend: string;
  name: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
};

// Choix exclusif en boutons segmentés (radios natives : flèches du clavier comprises).
function Choice<T extends string>({
  legend,
  name,
  options,
  value,
  onChange,
}: ChoiceProps<T>) {
  return (
    <fieldset className="segmented">
      <legend className="muted">{legend}</legend>
      <div className="segmented-options">
        {options.map((option) => (
          <label key={option.value} className="segmented-option">
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={option.value === value}
              onChange={() => onChange(option.value)}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function SeriesChart({
  series,
  data,
}: {
  series: Series;
  data: ProgressionResponse;
}) {
  const points: ChartPoint[] = data.buckets.map((bucket, i, all) => ({
    label: bucketLabel(bucket.start, data.group),
    detail:
      bucketPeriod(bucket.start, data.group) +
      (i === all.length - 1 ? " (en cours)" : ""),
    value: series.value(bucket),
  }));
  const unit = data.group === "week" ? "par semaine" : "par mois";
  const props = {
    title: `${series.title} ${unit}`,
    points,
    format: series.format,
    axisFormat: series.axisFormat,
    summary: describeSeries(
      series,
      completePeriods(points.map((p) => p.value)),
    ),
    inverted: series.inverted,
  };
  return series.kind === "bar" ? (
    <BarChart {...props} />
  ) : (
    <LineChart {...props} />
  );
}

// Récapitulatif du volume (issue #36), repliable, de la période la plus récente à la plus ancienne.
function VolumeTable({
  buckets,
  group,
}: {
  buckets: ProgressionBucket[];
  group: Grouping;
}) {
  return (
    <details className="card volume-table">
      <summary className="plan-summary">
        Détail {group === "week" ? "par semaine" : "par mois"}
      </summary>
      <div className="volume-table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">{group === "week" ? "Semaine du" : "Mois"}</th>
              <th scope="col">Distance</th>
              <th scope="col">Temps</th>
              <th scope="col">
                <span aria-hidden="true">Nb</span>
                <span className="visually-hidden">Courses</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {[...buckets].reverse().map((b) => (
              <tr key={b.start}>
                <th scope="row">{tableDate(b.start, group)}</th>
                <td>{SERIES[0].format(b.distanceM)}</td>
                <td>{formatHoursMinutes(b.movingTimeS)}</td>
                <td>{b.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function ImportLink({ children }: { children: string }) {
  return (
    <RouteLink view="history" className="text-link action-link">
      {children}
    </RouteLink>
  );
}

export function ProgressionView() {
  const [period, setPeriod] = useState<Period>("6m");
  const [group, setGroup] = useState<Grouping>("week");
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let current = true;
    setState({ status: "loading" });
    loadProgression(period, group).then((next) => current && setState(next));
    return () => {
      current = false;
    };
  }, [period, group]);

  const controls = (
    <div className="progression-controls">
      <Choice
        legend="Période"
        name="period"
        options={PERIOD_OPTIONS}
        value={period}
        onChange={setPeriod}
      />
      <Choice
        legend="Regrouper par"
        name="group"
        options={GROUP_OPTIONS}
        value={group}
        onChange={setGroup}
      />
    </div>
  );

  if (state.status === "loading") {
    return (
      <>
        {controls}
        <Loading label="Calcul de ta progression…" />
      </>
    );
  }
  if (state.status === "failed") {
    return (
      <>
        {controls}
        <Alert message="Impossible de charger ta progression. Réessaie dans un instant." />
      </>
    );
  }

  const { data } = state;
  if (data.lastRunDate === null) {
    return (
      <section className="card state state-empty">
        <p>Aucune course pour l'instant.</p>
        <p className="muted">
          Importe le fichier activities.csv de ton export Strava pour voir ta
          progression.
        </p>
        <p>
          <ImportLink>Importer mon historique</ImportLink>
        </p>
      </section>
    );
  }

  const stale = staleMessage(data.lastImportedRunDate, data.historyStale);
  const [volume, ...others] = SERIES;
  return (
    <>
      {controls}
      {stale && (
        <div className="card state notice">
          <p>{stale}</p>
          <p>
            <ImportLink>Importer mon historique</ImportLink>
          </p>
        </div>
      )}
      <div className="chart-grid-layout">
        <div className="view-stack">
          <SeriesChart series={volume} data={data} />
          <VolumeTable buckets={data.buckets} group={data.group} />
        </div>
        {others.map((series) => (
          <SeriesChart key={series.id} series={series} data={data} />
        ))}
      </div>
    </>
  );
}
