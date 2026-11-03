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
  formatKm,
  GROUP_OPTIONS,
  PERIOD_OPTIONS,
  SERIES,
  completePeriods,
  staleMessage,
  type Series,
} from "./progression";
import { Alert, Loading } from "./ui";

// Les données précédentes restent affichées pendant un rechargement (pas de saut de page).
type State = {
  data: ProgressionResponse | null;
  loading: boolean;
  failed: boolean;
};

async function loadProgression(
  period: Period,
  group: Grouping,
): Promise<ProgressionResponse | null> {
  try {
    const response = await fetch(
      `/api/progression?period=${period}&group=${group}`,
    );
    if (!response.ok) return null;
    return (await response.json()) as ProgressionResponse;
  } catch {
    return null;
  }
}

// Petit écran : « Tout » par semaine ferait des centaines de barres d'un pixel.
const NARROW_QUERY = "(max-width: 767.98px)";

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(
    () => window.matchMedia(NARROW_QUERY).matches,
  );
  useEffect(() => {
    const media = window.matchMedia(NARROW_QUERY);
    const onChange = () => setNarrow(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  return narrow;
}

type ChoiceProps<T extends string> = {
  legend: string;
  name: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  disabled?: T | null; // option indisponible (expliquée à côté)
};

// Choix exclusif en boutons segmentés (radios natives : flèches du clavier comprises).
function Choice<T extends string>({
  legend,
  name,
  options,
  value,
  onChange,
  disabled = null,
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
              disabled={option.value === disabled}
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
    minSpan: series.minSpan,
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
      <div
        className="volume-table-scroll"
        tabIndex={0}
        role="region"
        aria-label={`Volume ${group === "week" ? "par semaine" : "par mois"}`}
      >
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
                <td>{formatKm(b.distanceM)}</td>
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
  const [chosenGroup, setGroup] = useState<Grouping>("week");
  const narrow = useNarrow();
  const weeksTooMany = narrow && period === "all";
  const group = weeksTooMany ? "month" : chosenGroup;
  const [state, setState] = useState<State>({
    data: null,
    loading: true,
    failed: false,
  });

  useEffect(() => {
    let current = true;
    setState((previous) => ({ ...previous, loading: true, failed: false }));
    loadProgression(period, group).then((data) => {
      if (!current) return;
      setState((previous) =>
        data === null
          ? { ...previous, loading: false, failed: true }
          : { data, loading: false, failed: false },
      );
    });
    return () => {
      current = false;
    };
  }, [period, group]);

  const { data, loading, failed } = state;
  if (data === null && loading) {
    return <Loading label="Calcul de ta progression…" />;
  }
  if (data?.lastRunDate === null) {
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

  const stale = data && staleMessage(data);
  const [volume, ...others] = SERIES;
  return (
    <>
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
          disabled={weeksTooMany ? "week" : null}
        />
        {weeksTooMany && (
          <p className="muted progression-hint">
            Sur toute la période, le détail par semaine s'affiche sur un écran
            plus large.
          </p>
        )}
      </div>
      <p className="muted progression-status" role="status">
        {loading ? "Mise à jour…" : ""}
      </p>
      {failed && (
        <Alert message="Impossible de charger ta progression. Réessaie dans un instant." />
      )}
      {stale && (
        <div className="card state notice">
          <p>{stale}</p>
          <p>
            <ImportLink>Importer mon historique</ImportLink>
          </p>
        </div>
      )}
      {data && (
        <section aria-labelledby="progression-charts-title" aria-busy={loading}>
          <h2 id="progression-charts-title" className="visually-hidden">
            Graphiques
          </h2>
          <div className="chart-grid-layout">
            <div className="view-stack">
              <SeriesChart series={volume} data={data} />
              <VolumeTable buckets={data.buckets} group={data.group} />
            </div>
            {others.map((series) => (
              <SeriesChart key={series.id} series={series} data={data} />
            ))}
          </div>
        </section>
      )}
    </>
  );
}
