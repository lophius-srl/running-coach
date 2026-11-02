import type { RecentRuns as RecentRunsData } from "../worker/activities/recent";
import { HEART_RATE_ZONES } from "../core/heart-rate";
import {
  formatAltitudeRange,
  formatDistance,
  formatDuration,
  formatElevationGain,
  formatElevationPerKm,
  formatHeartrate,
  formatMetersPerBeat,
  formatPace,
  formatRunName,
  formatShare,
  formatStartDate,
  formatVdot,
} from "./format";

// Consignes de marque Strava (https://developers.strava.com/guidelines/) : lien « View on Strava »
// par activité ; le logo « Powered by Strava » est affiché dans le pied de page de l'app.

const HEADING_ID = "recent-runs-title";

function WeekTotal({ total }: { total: RecentRunsData["total"] }) {
  return (
    <>
      <h3 className="visually-hidden">Total de la semaine</h3>
      <dl className="card key-figures">
        <div className="key-figure">
          <dt>Distance</dt>
          <dd>{formatDistance(total.distanceM)}</dd>
        </div>
        <div className="key-figure">
          <dt>Temps</dt>
          <dd>{formatDuration(total.movingTimeS)}</dd>
        </div>
        <div className="key-figure">
          <dt>Courses</dt>
          <dd>{total.count}</dd>
        </div>
        <div className="key-figure">
          <dt>
            D+<span className="visually-hidden"> (dénivelé positif)</span>
          </dt>
          <dd>{formatElevationGain(total.elevationGainM)}</dd>
          <dt className="visually-hidden">D+ par km</dt>
          <dd className="figure-ratio">
            {formatElevationPerKm(total.elevationPerKm)}
          </dd>
        </div>
      </dl>
    </>
  );
}

type Run = RecentRunsData["runs"][number];

const SURFACE_LABELS: Record<Run["surface"], string> = {
  road: "Route",
  trail: "Trail",
  treadmill: "Tapis",
};

const WORKOUT_LABELS: Record<NonNullable<Run["workout"]>, string> = {
  race: "Course",
  long: "Sortie longue",
  intervals: "Fractionné",
};

const PACE_ZONE_LABELS: Record<NonNullable<Run["paceZone"]>, string> = {
  recovery: "Récupération",
  endurance: "Endurance",
  tempo: "Tempo",
  threshold: "Seuil",
  above_threshold: "Entre seuil et VMA",
  vma: "VMA",
};

function heartRateZoneLabel(zone: number): string {
  const { label, name } = HEART_RATE_ZONES[zone - 1];
  return `${label} · ${name}`;
}

const positiveCount = (value: number | null) =>
  value !== null && value > 0 ? String(value) : null;

type Detail = [label: string, value: string | null];

const known = <T,>(value: T | null, format: (value: T) => string) =>
  value === null ? null : format(value);

// Détails de la sortie en trois groupes thématiques ; les données absentes seront masquées.
function runDetails(run: Run): [title: string, details: Detail[]][] {
  return [
    [
      "Allure et effort",
      [
        [
          "Zone d'allure",
          known(run.paceZone, (zone) => PACE_ZONE_LABELS[zone]),
        ],
        ["Allure max", known(run.maxPaceSPerKm, formatPace)],
        ["Temps total", known(run.elapsedTimeS, formatDuration)],
        ["Pauses", known(run.pauseS, formatDuration)],
        ["VDOT", known(run.vdot, formatVdot)],
        [
          "Effort relatif",
          known(run.sufferScore, (s) => String(Math.round(s))),
        ],
      ],
    ],
    [
      "Cœur et foulée",
      [
        ["FC moyenne", known(run.averageHeartrate, formatHeartrate)],
        ["FC max", known(run.maxHeartrate, formatHeartrate)],
        ["Zone cardiaque", known(run.heartRateZone, heartRateZoneLabel)],
        ["Efficacité", known(run.metersPerBeat, formatMetersPerBeat)],
        ["Cadence", known(run.cadenceSpm, (spm) => `${spm} pas/min`)],
      ],
    ],
    [
      "Terrain et semaine",
      [
        [
          "Altitude min – max",
          run.elevLowM === null || run.elevHighM === null
            ? null
            : formatAltitudeRange(run.elevLowM, run.elevHighM),
        ],
        ["Part de la semaine", known(run.weekShare, formatShare)],
        ["Records", positiveCount(run.prCount)],
        ["Succès", positiveCount(run.achievementCount)],
        ["Kudos", known(run.kudosCount, String)],
      ],
    ],
  ];
}

function DetailGroup({ title, details }: { title: string; details: Detail[] }) {
  const shown = details.filter(
    (detail): detail is [string, string] => detail[1] !== null,
  );
  if (shown.length === 0) return null;
  return (
    <section className="run-detail-group">
      <h4 className="run-detail-title">{title}</h4>
      <dl className="run-details">
        {shown.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

// Une sortie : en-tête (date, nom, badges), quatre chiffres clés, grille de détails, lien Strava.
function RunCard({ run }: { run: Run }) {
  const startDate = formatStartDate(run.startDate);
  const name = formatRunName(run.name);
  const badges = [
    SURFACE_LABELS[run.surface],
    ...(run.workout ? [WORKOUT_LABELS[run.workout]] : []),
  ];
  return (
    <li>
      <article className="card run-card">
        <header className="run-card-header">
          <time className="muted" dateTime={run.startDate}>
            {startDate}
          </time>
          <h3 className="run-name">{name}</h3>
          <ul className="run-badges" aria-label="Type de sortie">
            {badges.map((badge) => (
              <li key={badge} className="badge">
                {badge}
              </li>
            ))}
          </ul>
        </header>
        <dl className="key-figures run-key-figures">
          <div className="key-figure">
            <dt>Distance</dt>
            <dd>{formatDistance(run.distanceM)}</dd>
          </div>
          <div className="key-figure">
            <dt>Durée</dt>
            <dd>{formatDuration(run.movingTimeS)}</dd>
          </div>
          <div className="key-figure">
            <dt>Allure</dt>
            <dd>{formatPace(run.paceSPerKm)}</dd>
          </div>
          <div className="key-figure">
            <dt>
              D+<span className="visually-hidden"> (dénivelé positif)</span>
            </dt>
            <dd>{formatElevationGain(run.elevationGainM)}</dd>
            {run.elevationGainM !== null && (
              <>
                <dt className="visually-hidden">D+ par km</dt>
                <dd className="figure-ratio">
                  {formatElevationPerKm(run.elevationPerKm)}
                </dd>
              </>
            )}
          </div>
        </dl>
        {runDetails(run).map(([title, details]) => (
          <DetailGroup key={title} title={title} details={details} />
        ))}
        <a
          className="strava-link"
          href={`https://www.strava.com/activities/${run.id}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          View on Strava
          <span className="visually-hidden">
            {` : ${run.name || startDate} (nouvel onglet)`}
          </span>
        </a>
      </article>
    </li>
  );
}

export function RecentRuns({ data }: { data: RecentRunsData }) {
  return (
    <section aria-labelledby={HEADING_ID}>
      <h2 id={HEADING_ID} className="section-title">
        Mes runs des 7 derniers jours
      </h2>
      {data.runs.length === 0 ? (
        <div className="card state state-empty">
          <p>Aucune course sur les 7 derniers jours.</p>
          <p className="muted">
            Appuie sur « Synchroniser maintenant » pour récupérer tes dernières
            sorties Strava, ou va courir !
          </p>
        </div>
      ) : (
        <>
          <WeekTotal total={data.total} />
          <ul className="run-cards">
            {data.runs.map((run) => (
              <RunCard key={run.id} run={run} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
