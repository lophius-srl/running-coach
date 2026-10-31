import type { PaceBasis } from "../core/fitness";
import type { TrainingPaces } from "../core/paces";
import {
  formatDuration,
  formatPaceBasis,
  formatPaceRange,
  formatSpeedRange,
} from "./format";

const HEADING_ID = "paces-title";

type ZoneKey = "endurance" | "threshold" | "vma" | "race";

const ZONES: { key: ZoneKey; label: string; hint: string }[] = [
  { key: "endurance", label: "Endurance", hint: "footing facile, en aisance" },
  { key: "threshold", label: "Seuil", hint: "soutenu, tenable environ 1 h" },
  { key: "vma", label: "VMA", hint: "fractionné court, 3 à 5 min" },
  { key: "race", label: "Allure course", hint: "allure de ton objectif" },
];

type Props = { paces: TrainingPaces; basis: PaceBasis };

// Sous-section de « Mon objectif » : allures calculées depuis la meilleure course des 8 dernières
// semaines (méthode VDOT de Jack Daniels, voir src/core/fitness.ts et src/core/paces.ts).
export function Paces({ paces, basis }: Props) {
  return (
    <section className="paces-section" aria-labelledby={HEADING_ID}>
      <h3 id={HEADING_ID} className="section-title">
        Mes allures
      </h3>
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
            <span className="alert-label">Attention :</span>{" "}
            {paces.targetWarning}
          </p>
        )}
      </div>
    </section>
  );
}
