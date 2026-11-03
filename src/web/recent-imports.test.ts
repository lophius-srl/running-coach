import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RecentImport } from "../worker/imports/types";
import { RecentImportsList } from "./RecentImports";
import { recentImportLine } from "./recent-imports";

const activity = {
  startDate: "2026-11-03T07:30:00Z",
  sportType: "TrailRun",
  distanceM: 10_204,
  movingTimeS: 3130,
};

const item = (fields: Partial<RecentImport>): RecentImport => ({
  id: 1,
  receivedAt: "2026-11-03T09:10:00.000Z",
  status: "imported",
  activity,
  ...fields,
});

describe("recentImportLine", () => {
  it("décrit un envoi importé et sa séance", () => {
    expect(recentImportLine(item({}), "Europe/Paris")).toEqual({
      receivedAt: "mar. 3 nov., 10:10",
      status: "Importée",
      ok: true,
      session: "Trail du 3 nov. 2026 · 10,20 km en 52:10",
    });
  });

  it("signale un refus, sans séance", () => {
    expect(
      recentImportLine(item({ status: "not_fit", activity: null }), "UTC"),
    ).toMatchObject({ status: "Pas un fichier FIT", ok: false, session: null });
  });

  it("nomme « Séance » un sport inconnu et « Déjà importée » un doublon", () => {
    const line = recentImportLine(
      item({
        status: "duplicate",
        activity: { ...activity, sportType: "Workout" },
      }),
    );
    expect(line.status).toBe("Déjà importée");
    expect(line.ok).toBe(true);
    expect(line.session).toMatch(/^Séance du 3 nov\. 2026/);
  });
});

describe("RecentImportsList", () => {
  const render = (imports: RecentImport[]) =>
    renderToStaticMarkup(createElement(RecentImportsList, { imports }));

  it("affiche un message quand aucun envoi n'existe", () => {
    expect(render([])).toContain("Aucun envoi pour l&#x27;instant.");
  });

  it("liste chaque envoi avec son statut et sa séance", () => {
    const html = render([
      item({ id: 2, status: "invalid", activity: null }),
      item({ id: 1 }),
    ]);
    expect(html).toContain(
      '<span class="badge badge-warning">Fichier illisible</span>',
    );
    expect(html).toContain('<span class="badge">Importée</span>');
    expect(html).toContain("Trail du 3 nov. 2026 · 10,20 km en 52:10");
    expect(html.match(/<li>/g)).toHaveLength(2);
  });
});
