import type { RecentRuns as RecentRunsData } from "../worker/activities/recent";
import {
  formatDistance,
  formatDuration,
  formatHeartrate,
  formatPace,
  formatRunDay,
  formatRunName,
  formatStartDate,
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
      </dl>
    </>
  );
}

// Une sortie sur deux lignes, après la colonne du jour : nom et lien Strava, puis chiffres.
// Les libellés des chiffres sont lus par les lecteurs d'écran ; à l'écran, les unités suffisent.
function RunRow({ run }: { run: RecentRunsData["runs"][number] }) {
  const startDate = formatStartDate(run.startDate);
  const { weekday, day } = formatRunDay(run.startDate);
  const figures = [
    ["Distance", formatDistance(run.distanceM)],
    ["Durée", formatDuration(run.movingTimeS)],
    ["Allure moyenne", formatPace(run.paceSPerKm)],
    ["FC moyenne", formatHeartrate(run.averageHeartrate)],
  ];
  return (
    <li className="run-row">
      <time className="run-day" dateTime={run.startDate} title={startDate}>
        <span>{weekday}</span> <span>{day}</span>
      </time>
      <h3 className="run-name" title={formatRunName(run.name)}>
        {formatRunName(run.name)}
      </h3>
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
      <dl className="run-figures">
        {figures.map(([label, value]) => (
          <div key={label}>
            <dt className="visually-hidden">{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
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
          <ul className="card run-list">
            {data.runs.map((run) => (
              <RunRow key={run.id} run={run} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
