import type { RecentRuns as RecentRunsData } from "../worker/activities/recent";
import {
  formatDistance,
  formatDuration,
  formatHeartrate,
  formatPace,
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
      <dl className="key-figures">
        <div className="card key-figure">
          <dt>Distance</dt>
          <dd>{formatDistance(total.distanceM)}</dd>
        </div>
        <div className="card key-figure">
          <dt>Temps</dt>
          <dd>{formatDuration(total.movingTimeS)}</dd>
        </div>
        <div className="card key-figure">
          <dt>Courses</dt>
          <dd>{total.count}</dd>
        </div>
      </dl>
    </>
  );
}

function RunCard({ run }: { run: RecentRunsData["runs"][number] }) {
  const startDate = formatStartDate(run.startDate);
  return (
    <li className="card run-card">
      <h3 className="run-name">{formatRunName(run.name)}</h3>
      <p className="muted">
        <time dateTime={run.startDate}>{startDate}</time>
      </p>
      <dl className="run-stats">
        <div>
          <dt>Distance</dt>
          <dd>{formatDistance(run.distanceM)}</dd>
        </div>
        <div>
          <dt>Durée</dt>
          <dd>{formatDuration(run.movingTimeS)}</dd>
        </div>
        <div>
          <dt>Allure moyenne</dt>
          <dd>{formatPace(run.paceSPerKm)}</dd>
        </div>
        <div>
          <dt>FC moyenne</dt>
          <dd>{formatHeartrate(run.averageHeartrate)}</dd>
        </div>
      </dl>
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
          <ul className="run-list">
            {data.runs.map((run) => (
              <RunCard key={run.id} run={run} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
