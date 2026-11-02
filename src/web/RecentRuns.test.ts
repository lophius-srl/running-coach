import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type {
  RecentRun,
  RecentRuns as RecentRunsData,
} from "../worker/activities/recent";
import { RecentRuns } from "./RecentRuns";

function run(fields: Partial<RecentRun>): RecentRun {
  return {
    id: 1,
    name: "Footing",
    startDate: "2026-10-29T06:00:00Z",
    startDateLocal: null,
    distanceM: 10000,
    movingTimeS: 3000,
    paceSPerKm: 300,
    averageHeartrate: null,
    elevationGainM: null,
    elevationPerKm: null,
    sportType: "Run",
    surface: "road",
    workout: null,
    elapsedTimeS: null,
    pauseS: null,
    maxPaceSPerKm: null,
    maxHeartrate: null,
    cadenceSpm: null,
    elevLowM: null,
    elevHighM: null,
    sufferScore: null,
    prCount: null,
    achievementCount: null,
    kudosCount: null,
    paceZone: null,
    heartRateZone: null,
    metersPerBeat: null,
    vdot: null,
    weekShare: null,
    ...fields,
  };
}

function render(
  runs: RecentRun[],
  total: Partial<RecentRunsData["total"]> = {},
): string {
  const data: RecentRunsData = {
    runs,
    total: {
      count: runs.length,
      distanceM: 10000,
      movingTimeS: 3000,
      elevationGainM: null,
      elevationPerKm: null,
      ...total,
    },
  };
  return renderToStaticMarkup(createElement(RecentRuns, { data }));
}

// Un chiffre clé de la carte (bloc .run-figure), par son libellé visible.
function runFigure(html: string, label: string): string {
  const figures = html.match(/<div class="run-figure">.*?<\/div>/g) ?? [];
  const figure = figures.find((block) => block.includes(`<dt>${label}`));
  if (!figure) throw new Error(`chiffre clé ${label} absent`);
  return figure;
}

// Paires « libellé : valeur » d'une liste de la carte (repères ou volet de détails).
function pairs(html: string, className: "run-hints" | "run-details") {
  const match = new RegExp(`<dl class="${className}">(.*?)</dl>`).exec(html);
  if (!match) return [];
  return [
    ...match[1].matchAll(
      /<dt(?: class="visually-hidden")?>(.*?)<\/dt><dd>(.*?)<\/dd>/g,
    ),
  ].map(([, label, value]) => `${label} : ${value}`);
}

const runDetails = (html: string) => pairs(html, "run-details");
const runHints = (html: string) => pairs(html, "run-hints");

describe("RecentRuns card of a run", () => {
  it("shows the name before the start in the DOM, the badges and the Strava link", () => {
    const html = render([
      run({ id: 42, name: "Piste", surface: "trail", workout: "intervals" }),
    ]);

    expect(html).toContain(
      '<h3 class="run-name" title="Piste">Piste</h3><time class="run-date" dateTime="2026-10-29T06:00:00Z">',
    );
    expect(html).toContain(
      '<li class="badge">Trail</li><li class="badge">Fractionné</li>',
    );
    expect(html).toContain('href="https://www.strava.com/activities/42"');
  });

  it("shows the local start time Strava sends, whatever the browser time zone", () => {
    const html = render([
      run({
        startDate: "2026-10-29T06:00:00Z",
        startDateLocal: "2026-10-29T15:00:00Z", // départ à 15 h, heure de Tokyo
      }),
    ]);

    expect(html).toMatch(/<time class="run-date"[^>]*>[^<]*15:00<\/time>/);
  });

  it("shows the five key figures", () => {
    const html = render([run({ averageHeartrate: 151.6 })]);

    expect(runFigure(html, "Distance")).toContain("<dd>10,00 km</dd>");
    expect(runFigure(html, "Durée")).toContain("<dd>0:50:00</dd>");
    expect(runFigure(html, "Allure")).toContain("<dd>5:00/km</dd>");
    expect(runFigure(html, "FC moy.")).toContain("<dd>152 bpm</dd>");
  });

  it("shows a dash for a missing mean heart rate", () => {
    expect(runFigure(render([run({})]), "FC moy.")).toContain("<dd>–</dd>");
  });

  it("shows the heart rate zone, cadence and efficiency as hints", () => {
    const html = render([
      run({ heartRateZone: 2, cadenceSpm: 172, metersPerBeat: 1.5234 }),
    ]);

    expect(runHints(html)).toEqual([
      "Zone cardiaque : Z2 · Endurance",
      "Cadence : 172 pas/min",
      "Efficacité : 1,52 m/batt.",
    ]);
    expect(html).toContain('<dt class="visually-hidden">Cadence</dt>');
  });

  it("hides the hints when none is known", () => {
    expect(render([run({})])).not.toContain("run-hints");
  });

  it("lists the other details in a collapsed panel", () => {
    const html = render([
      run({
        paceZone: "threshold",
        maxPaceSPerKm: 200,
        elapsedTimeS: 3210,
        pauseS: 210,
        maxHeartrate: 181,
        elevLowM: 112.4,
        elevHighM: 245.6,
        vdot: 47.26,
        sufferScore: 86.6,
        weekShare: 0.337,
        prCount: 2,
        achievementCount: 5,
        kudosCount: 0,
      }),
    ]);

    expect(runDetails(html)).toEqual([
      "Zone d&#x27;allure : Seuil",
      "Allure max : 3:20/km",
      "Temps total : 0:53:30",
      "Pauses : 0:03:30",
      "FC max : 181 bpm",
      "VDOT : 47,3",
      "Effort relatif : 87",
      "Altitude min – max : 112 – 246 m",
      "Part de la semaine : 34 %",
      "Records : 2",
      "Succès : 5",
      "Kudos : 0",
    ]);
    expect(html).toMatch(
      /<button type="button" class="run-toggle" aria-expanded="false" aria-controls="([^"]+)">Plus de détails<\/button>.*<div id="\1" class="run-panel" hidden="">/,
    );
  });

  it("hides unknown details, zero pauses and zero records", () => {
    expect(
      runDetails(render([run({ kudosCount: 3, prCount: 0, pauseS: 0 })])),
    ).toEqual(["Kudos : 3"]);
  });

  it("drops the panel and its button when no detail is known", () => {
    const html = render([run({})]);

    expect(html).not.toContain("run-panel");
    expect(html).not.toContain("run-toggle");
    expect(html).toContain("View on Strava");
  });

  it("hides the altitude when only one bound is known", () => {
    expect(runDetails(render([run({ elevLowM: 10 })]))).toEqual([]);
  });
});

describe("RecentRuns elevation gain of a run", () => {
  it("shows the elevation gain with its ratio after the label", () => {
    const html = render([run({ elevationGainM: 245, elevationPerKm: 29 })]);

    expect(runFigure(html, "D+")).toBe(
      '<div class="run-figure"><dt>D+<span class="visually-hidden"> (dénivelé positif)</span></dt><dd>245 m</dd><dt class="visually-hidden">D+ par km</dt><dd class="figure-ratio">29 m/km</dd></div>',
    );
  });

  it("shows a dash and no ratio when Strava has no elevation gain", () => {
    const elevation = runFigure(render([run({})]), "D+");

    expect(elevation).toContain("<dd>–</dd>");
    expect(elevation).not.toContain("figure-ratio");
  });

  it("shows no ratio for a zero-distance run with elevation gain", () => {
    const elevation = runFigure(
      render([run({ distanceM: 0, elevationGainM: 4, elevationPerKm: null })]),
      "D+",
    );

    expect(elevation).toContain("<dd>4 m</dd>");
    expect(elevation).not.toContain("figure-ratio");
  });
});

describe("RecentRuns elevation gain of the week", () => {
  it("shows the total elevation gain with the overall ratio below", () => {
    const html = render([run({ elevationGainM: 245, elevationPerKm: 29 })], {
      elevationGainM: 245,
      elevationPerKm: 13,
    });

    expect(html).toContain(
      '<dt>D+<span class="visually-hidden"> (dénivelé positif)</span></dt><dd>245 m</dd><dt class="visually-hidden">D+ par km</dt><dd class="figure-ratio">13 m/km</dd>',
    );
  });

  it("shows dashes when no run of the week has an elevation gain", () => {
    const html = render([run({})]);

    expect(html).toContain(
      '<dd>–</dd><dt class="visually-hidden">D+ par km</dt><dd class="figure-ratio">–</dd>',
    );
  });
});

describe("RecentRuns card labels (QA #60)", () => {
  it.each([
    ["road", null, "Route"],
    ["treadmill", "race", 'Tapis</li><li class="badge">Compétition'],
    ["road", "long", 'Route</li><li class="badge">Sortie longue'],
  ] as const)("shows the %s / %s badges", (surface, workout, badges) => {
    expect(render([run({ surface, workout })])).toContain(
      `<li class="badge">${badges}</li></ul>`,
    );
  });

  it.each([
    ["recovery", "Récupération"],
    ["endurance", "Endurance"],
    ["tempo", "Tempo"],
    ["above_threshold", "Entre seuil et VMA"],
    ["vma", "VMA"],
  ] as const)("names the %s pace zone %s", (paceZone, label) => {
    expect(runDetails(render([run({ paceZone })]))).toContain(
      `Zone d&#x27;allure : ${label}`,
    );
  });

  it.each([
    [1, "Z1 · Récupération"],
    [5, "Z5 · VMA"],
  ])("names heart rate zone %i %s", (heartRateZone, label) => {
    expect(runHints(render([run({ heartRateZone })]))).toContain(
      `Zone cardiaque : ${label}`,
    );
  });

  it("hides zero achievements", () => {
    expect(runDetails(render([run({ achievementCount: 0 })]))).toEqual([]);
  });
});

describe("RecentRuns card name (QA #60)", () => {
  it("falls back on a default title for a blank name", () => {
    expect(render([run({ name: "   " })])).toContain(
      '<h3 class="run-name" title="Course sans titre">Course sans titre</h3>',
    );
  });

  it("escapes special characters of the Strava name", () => {
    const html = render([run({ name: '<img src=x onerror="alert(1)">' })]);

    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x");
  });

  it("names the Strava link after the formatted run name for screen readers", () => {
    expect(render([run({ id: 7, name: "  Footing  " })])).toContain(
      '<span class="visually-hidden"> : Footing (nouvel onglet)</span>',
    );
    expect(render([run({ id: 7, name: "" })])).toContain(
      '<span class="visually-hidden"> : Course sans titre (nouvel onglet)</span>',
    );
  });
});

describe("RecentRuns card structure (QA #60)", () => {
  it("renders one list item, one article and one h3 per run", () => {
    const html = render([run({ id: 1 }), run({ id: 2, name: "Seuil" })]);

    expect(html.match(/<article class="card run-card">/g)).toHaveLength(2);
    expect(html.match(/<h3 class="run-name"/g)).toHaveLength(2);
    expect(html).toContain('<ul class="run-cards"><li><article');
  });

  it("gives each card its own panel id", () => {
    const html = render([
      run({ id: 1, kudosCount: 1 }),
      run({ id: 2, kudosCount: 2 }),
    ]);
    const ids = [...html.matchAll(/aria-controls="([^"]+)"/g)].map(
      ([, id]) => id,
    );

    expect(new Set(ids).size).toBe(2);
  });

  it("keeps every detail pair inside a description list", () => {
    const html = render([run({ kudosCount: 1, maxHeartrate: 180 })]);

    expect(html).toMatch(
      /<dl class="run-details">(<div><dt>[^<]+<\/dt><dd>[^<]+<\/dd><\/div>)+<\/dl>/,
    );
  });
});
