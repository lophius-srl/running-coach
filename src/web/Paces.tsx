import {
  MAX_DISTANCE_M,
  MIN_DISTANCE_M,
  type PaceBasis,
} from "../core/fitness";
import type { TrainingPaces } from "../core/paces";
import { RouteLink } from "./AppNav";
import {
  formatDuration,
  formatPaceBasis,
  formatPaceRange,
  formatSpeedRange,
} from "./format";

const HEADING_ID = "paces-title";

type ZoneKey = "endurance" | "threshold" | "vma" | "race";

export const ZONES: { key: ZoneKey; label: string; hint: string }[] = [
  { key: "endurance", label: "Endurance", hint: "footing facile, en aisance" },
  { key: "threshold", label: "Seuil", hint: "soutenu, tenable environ 1 h" },
  { key: "vma", label: "VMA", hint: "fractionné court, 3 à 5 min" },
  { key: "race", label: "Allure course", hint: "allure de ton objectif" },
];

type Props = { paces: TrainingPaces | null; basis: PaceBasis | null };

// Raison de l'absence d'allures : pas de course exploitable, ou pas encore d'objectif.
// linkGoal : lien vers la vue Objectif (inutile sur cette vue, où le formulaire est à côté).
export function MissingPaces({
  basis,
  linkGoal = false,
}: Pick<Props, "basis"> & { linkGoal?: boolean }) {
  if (basis && !linkGoal) {
    return (
      <p className="muted">
        Enregistre ton objectif avec le formulaire pour voir tes allures.
      </p>
    );
  }
  if (basis) {
    return (
      <p className="muted">
        Enregistre ton{" "}
        <RouteLink view="goal" className="text-link">
          objectif
        </RouteLink>{" "}
        pour voir tes allures.
      </p>
    );
  }
  return (
    <p className="muted">
      Pas d'allures pour l'instant : aucune course exploitable sur les 8
      dernières semaines (course à pied de {MIN_DISTANCE_M / 1000} à{" "}
      {MAX_DISTANCE_M / 1000} km, à une allure réaliste). Synchronise tes
      activités Strava ou importe ton{" "}
      <RouteLink view="history" className="text-link">
        historique
      </RouteLink>
      .
    </p>
  );
}

// Allures calculées depuis la meilleure course des 8 dernières semaines (méthode VDOT de
// Jack Daniels, voir src/core/fitness.ts et src/core/paces.ts), ou la raison de leur absence.
export function Paces({ paces, basis }: Props) {
  return (
    <section className="paces-section" aria-labelledby={HEADING_ID}>
      <h2 id={HEADING_ID} className="section-title">
        Mes allures
      </h2>
      {paces && basis ? (
        <PaceDetails paces={paces} basis={basis} />
      ) : (
        <div className="card state">
          <MissingPaces basis={basis} />
        </div>
      )}
    </section>
  );
}

function PaceDetails({
  paces,
  basis,
}: {
  paces: TrainingPaces;
  basis: PaceBasis;
}) {
  return (
    <div className="card paces">
      <p className="muted">
        Calculées {formatPaceBasis(basis)}, ta meilleure performance des 8
        dernières semaines.
      </p>
      <dl className="pace-list">
        {ZONES.map(({ key, label, hint }) => {
          const zone = paces[key];
          return (
            <div key={key} className="pace-zone">
              <dt>
                {label} <span className="muted">({hint})</span>
              </dt>
              <dd>
                {formatPaceRange(zone.fastSPerKm, zone.slowSPerKm)}
                <span className="pace-speed muted">
                  {formatSpeedRange(zone.fastSPerKm, zone.slowSPerKm)}
                </span>
              </dd>
            </div>
          );
        })}
      </dl>
      <p className="muted">
        Chrono prédit par ton niveau actuel sur la distance de ton objectif :{" "}
        {formatDuration(paces.predictedTimeS)}.
      </p>
      {paces.targetWarning && (
        <p className="alert" role="status">
          <span className="alert-label">Attention :</span> {paces.targetWarning}
        </p>
      )}
    </div>
  );
}
