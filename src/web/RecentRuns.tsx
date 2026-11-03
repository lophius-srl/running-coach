import { useId, useState } from "react";
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
  formatRunStart,
  formatShare,
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
  race: "Compétition",
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

type Detail = [label: string, value: string | null];

const known = <T,>(value: T | null, format: (value: T) => string) =>
  value === null ? null : format(value);

const positive = <T extends number>(value: T | null) =>
  value !== null && value > 0 ? value : null;

function shown(details: Detail[]): [string, string][] {
  return details.filter(
    (detail): detail is [string, string] => detail[1] !== null,
  );
}

// Repères sous les chiffres clés (masqués si absents).
function runHints(run: Run): Detail[] {
  return [
    ["Zone cardiaque", known(run.heartRateZone, heartRateZoneLabel)],
    ["Cadence", known(run.cadenceSpm, (spm) => `${spm} pas/min`)],
    ["Efficacité", known(run.metersPerBeat, formatMetersPerBeat)],
  ];
}

// Contenu du volet « Plus de détails » (données absentes masquées).
function runDetails(run: Run): Detail[] {
  return [
    ["Zone d'allure", known(run.paceZone, (zone) => PACE_ZONE_LABELS[zone])],
    ["Allure max", known(run.maxPaceSPerKm, formatPace)],
    ["Temps total", known(run.elapsedTimeS, formatDuration)],
    ["Pauses", known(positive(run.pauseS), formatDuration)],
    ["FC max", known(run.maxHeartrate, formatHeartrate)],
    ["VDOT", known(run.vdot, formatVdot)],
    ["Effort relatif", known(run.sufferScore, (s) => String(Math.round(s)))],
    [
      "Altitude min – max",
      run.elevLowM === null || run.elevHighM === null
        ? null
        : formatAltitudeRange(run.elevLowM, run.elevHighM),
    ],
    ["Part de la semaine", known(run.weekShare, formatShare)],
    ["Records", known(positive(run.prCount), String)],
    ["Succès", known(positive(run.achievementCount), String)],
    ["Kudos", known(run.kudosCount, String)],
  ];
}

function RunFigures({ run }: { run: Run }) {
  const figures: [string, string][] = [
    ["Distance", formatDistance(run.distanceM)],
    ["Durée", formatDuration(run.movingTimeS)],
    ["Allure", formatPace(run.paceSPerKm)],
  ];
  return (
    <dl className="run-figures">
      {figures.map(([label, value]) => (
        <div key={label} className="run-figure">
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
      <div className="run-figure">
        <dt>
          D+<span className="visually-hidden"> (dénivelé positif)</span>
        </dt>
        <dd>{formatElevationGain(run.elevationGainM)}</dd>
        {run.elevationGainM !== null && run.elevationPerKm !== null && (
          <>
            <dt className="visually-hidden">D+ par km</dt>
            <dd className="figure-ratio">
              {formatElevationPerKm(run.elevationPerKm)}
            </dd>
          </>
        )}
      </div>
      <div className="run-figure">
        <dt>FC moy.</dt>
        <dd>{formatHeartrate(run.averageHeartrate)}</dd>
      </div>
    </dl>
  );
}

// Liste « libellé : valeur » ; libellés lus seulement par les lecteurs d'écran si hiddenLabels.
function DetailList({
  className,
  details,
  hiddenLabels = false,
}: {
  className: string;
  details: [string, string][];
  hiddenLabels?: boolean;
}) {
  return (
    <dl className={className}>
      {details.map(([label, value]) => (
        <div key={label}>
          <dt className={hiddenLabels ? "visually-hidden" : undefined}>
            {label}
          </dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

// Une sortie : en-tête (date, nom, badges), cinq chiffres clés, repères, puis un volet replié
// avec le reste des détails, et le lien Strava (absent pour une séance montre sans Strava, id < 0).
function RunCard({ run }: { run: Run }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const startDate = formatRunStart(run.startDate, run.startDateLocal);
  const name = formatRunName(run.name);
  const badges = [
    SURFACE_LABELS[run.surface],
    ...(run.workout ? [WORKOUT_LABELS[run.workout]] : []),
  ];
  const hints = shown(runHints(run));
  const details = shown(runDetails(run));
  return (
    <li>
      <article className="card run-card">
        <header className="run-card-header">
          <h3 className="run-name" title={name}>
            {name}
          </h3>
          <time className="run-date" dateTime={run.startDate}>
            {startDate}
          </time>
          <ul className="run-badges" aria-label="Type de sortie">
            {badges.map((badge) => (
              <li key={badge} className="badge">
                {badge}
              </li>
            ))}
          </ul>
        </header>
        <RunFigures run={run} />
        {hints.length > 0 && (
          <DetailList className="run-hints" details={hints} hiddenLabels />
        )}
        <div className="run-card-footer">
          {details.length > 0 && (
            <button
              type="button"
              className="run-toggle"
              aria-expanded={open}
              aria-controls={panelId}
              onClick={() => setOpen(!open)}
            >
              Plus de détails
              <span className="visually-hidden">{` : ${name}`}</span>
            </button>
          )}
          {details.length > 0 && (
            <div id={panelId} className="run-panel" hidden={!open}>
              <DetailList className="run-details" details={details} />
            </div>
          )}
          {run.id > 0 && (
            <a
              className="strava-link"
              href={`https://www.strava.com/activities/${run.id}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              View on Strava
              <span className="visually-hidden">{` : ${name} (nouvel onglet)`}</span>
            </a>
          )}
        </div>
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
