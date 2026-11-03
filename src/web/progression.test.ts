import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BarChart, LineChart } from "./charts/Chart";
import {
  bucketLabel,
  bucketPeriod,
  completePeriods,
  describeSeries,
  formatHoursMinutes,
  tableDate,
  SERIES,
  staleMessage,
} from "./progression";

const series = (id: string) => SERIES.find((s) => s.id === id)!;

describe("libellés de période", () => {
  it("raccourcit l'axe et détaille la période", () => {
    expect(bucketLabel("2026-10-26", "week")).toBe("26 oct.");
    expect(bucketLabel("2026-10-01", "month")).toBe("oct.");
    expect(bucketLabel("2027-01-01", "month")).toBe("2027");
    expect(bucketPeriod("2026-12-28", "week")).toBe("semaine du 28 déc. 2026");
    expect(bucketPeriod("2026-10-01", "month")).toBe("octobre 2026");
    expect(tableDate("2026-11-02", "week")).toBe("02/11/2026");
    expect(tableDate("2026-11-01", "month")).toBe("nov. 2026");
  });
});

describe("describeSeries", () => {
  it("résume dernière valeur, moyenne et tendance", () => {
    expect(describeSeries(series("distance"), [20_000, 30_000, 40_000])).toBe(
      "Dernière période complète : 40 km · moyenne : 30 km · tendance : en hausse.",
    );
  });

  it("dit d'une allure qui baisse qu'elle est plus rapide", () => {
    expect(describeSeries(series("pace"), [330, null, 300])).toContain(
      "tendance : plus rapide",
    );
  });

  it("parle de dernière valeur quand la dernière période n'en a pas", () => {
    expect(describeSeries(series("heartrate"), [150, 152, null])).toMatch(
      /^Dernière valeur : 152 bpm/,
    );
  });

  it("applique un seuil de tendance propre à chaque série", () => {
    // +2,5 % : significatif pour le VDOT (2 %), pas pour le volume (5 %).
    expect(describeSeries(series("vdot"), [40, 41])).toContain("en hausse");
    expect(describeSeries(series("distance"), [40_000, 41_000])).toContain(
      "stable",
    );
    // +4 % de FC : en hausse (3 %).
    expect(describeSeries(series("heartrate"), [150, 156])).toContain(
      "en hausse",
    );
  });

  it("signale l'absence de données", () => {
    expect(describeSeries(series("vdot"), [null])).toBe(
      "Aucune donnée sur la période.",
    );
  });

  it("écarte la période en cours, sauf si elle est seule", () => {
    expect(completePeriods([1, 2, 3])).toEqual([1, 2]);
    expect(completePeriods([3])).toEqual([3]);
  });
});

describe("formatHoursMinutes", () => {
  it("arrondit à la minute", () => {
    expect(formatHoursMinutes(13_453)).toBe("3 h 44");
    expect(formatHoursMinutes(0)).toBe("0 h 00");
  });
});

describe("staleMessage", () => {
  const stale = {
    lastImportedRunDate: "2026-09-12T07:00:00Z",
    lastImportAt: "2026-09-14T20:00:00Z",
    historyStale: true,
  };

  it("donne la dernière course importée et la date du dernier import", () => {
    expect(staleMessage(stale)).toBe(
      "Ton historique importé s'arrête au 12 septembre 2026. Si tu as couru depuis ton dernier import du 14 septembre 2026, réimporte activities.csv pour le compléter.",
    );
  });

  it("invite à importer sans historique, et se tait s'il est à jour", () => {
    expect(
      staleMessage({
        lastImportedRunDate: null,
        lastImportAt: null,
        historyStale: true,
      }),
    ).toContain("importe ton historique");
    expect(staleMessage({ ...stale, historyStale: false })).toBeNull();
  });
});

describe("graphiques SVG", () => {
  const points = [
    { label: "a", detail: "semaine A", value: 300 },
    { label: "b", detail: "semaine B", value: null },
    { label: "c", detail: "semaine C", value: 310 },
    { label: "d", detail: "semaine D", value: 290 },
  ];
  const props = {
    title: "Allure",
    points,
    format: String,
    summary: "Résumé accessible.",
  };

  it("expose une image décrite, le résumé et la valeur de la dernière période", () => {
    const html = renderToStaticMarkup(createElement(BarChart, props));
    expect(html).toContain('role="img"');
    const svg = /<svg[^>]*>/.exec(html)![0];
    const titleId = /aria-labelledby="([^"]+)"/.exec(svg)![1];
    const summaryId = /aria-describedby="([^"]+)"/.exec(svg)![1];
    expect(html).toContain(
      `<h3 id="${titleId}" class="chart-title">Allure</h3>`,
    );
    expect(html).toContain(
      `id="${summaryId}" class="chart-summary muted">Résumé accessible.`,
    );
    expect(html).toContain('aria-live="off"'); // annonces seulement au clavier
    expect(html).toContain("semaine D : 290");
    expect(html).toContain('tabindex="0"');
    expect(html.match(/<rect/g)).toHaveLength(3); // pas de barre pour le trou
  });

  it("coupe la ligne sur une période sans donnée", () => {
    const html = renderToStaticMarkup(createElement(LineChart, props));
    expect(html.match(/<polyline/g)).toHaveLength(1); // C–D
    expect(html).toMatch(/class="chart-dot"/); // A, point isolé
  });
});

// --- QA #61 : rendu des graphiques aux cas limites ---

describe("graphiques SVG : cas limites", () => {
  const props = (values: (number | null)[]) => ({
    title: "Série",
    points: values.map((value, i) => ({
      label: `p${i}`,
      detail: `période ${i}`,
      value,
    })),
    format: String,
    summary: "Résumé.",
  });
  const render = (kind: typeof BarChart, values: (number | null)[]) =>
    renderToStaticMarkup(createElement(kind, props(values)));

  it.each([
    ["barres toutes nulles", BarChart, [null, null, null]],
    ["ligne toute nulle", LineChart, [null, null, null]],
    ["barres à zéro", BarChart, [0, 0, 0]],
    ["ligne à une seule valeur", LineChart, [300]],
    ["ligne constante", LineChart, [300, 300, 300]],
    ["aucune période", LineChart, []],
  ] as const)("%s : aucune coordonnée NaN ni infinie", (_, kind, values) => {
    const html = render(kind, [...values]);
    expect(html).not.toMatch(/NaN|Infinity/);
  });

  it("ne trace rien pour une ligne sans aucune valeur", () => {
    const html = render(LineChart, [null, null]);
    expect(html).not.toContain("<polyline");
    expect(html).not.toContain("chart-dot");
    expect(html).toContain("période 1 : pas de donnée");
  });

  it("dessine un point pour une ligne à une seule valeur", () => {
    const html = render(LineChart, [300]);
    expect(html).not.toContain("<polyline");
    expect(html).toContain('class="chart-dot"');
  });

  it("place l'allure la plus rapide en haut sur l'axe inversé", () => {
    const html = renderToStaticMarkup(
      createElement(LineChart, { ...props([240, 360]), inverted: true }),
    );
    const [first, second] = html
      .match(/<polyline[^>]*points="([^"]+)"/)![1]
      .split(" ")
      .map((p) => Number(p.split(",")[1]));
    expect(first).toBeLessThan(second); // 4:00/km plus haut (y plus petit) que 6:00/km
  });

  it("place la plus grande valeur en haut sur un axe normal", () => {
    const html = render(LineChart, [240, 360]);
    const [first, second] = html
      .match(/<polyline[^>]*points="([^"]+)"/)![1]
      .split(" ")
      .map((p) => Number(p.split(",")[1]));
    expect(first).toBeGreaterThan(second);
  });

  // Bug QA #61 corrigé : étendue minimale par série (1 000 m pour le volume) quand tout est à 0.
  it("donne des graduations distinctes au volume d'une période sans course", () => {
    const volume = series("distance");
    const html = renderToStaticMarkup(
      createElement(BarChart, {
        ...props([0, 0, 0]),
        format: volume.format,
        axisFormat: volume.axisFormat,
        minSpan: volume.minSpan,
      }),
    );
    const labels = [
      ...html.matchAll(/<text[^>]*text-anchor="end"[^>]*>([^<]*)</g),
    ].map((m) => m[1]);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels.at(-1)).toBe("1");
  });

  it("n'affiche ni graduation ni tracé pour une ligne sans aucune valeur", () => {
    const html = renderToStaticMarkup(
      createElement(LineChart, props([null, null, null])),
    );
    expect(html).toContain("Aucune donnée sur la période");
    expect(html).not.toMatch(/text-anchor="end"/);
    expect(html).not.toContain("<polyline");
  });

  it("donne au D+ une étendue minimale de 100 m", () => {
    expect(series("elevation").minSpan).toBe(100);
    expect(series("longest").minSpan).toBe(1000);
  });
});

describe("describeSeries : cas limites", () => {
  it("résume une série de zéros comme stable", () => {
    expect(describeSeries(series("distance"), [0, 0, 0])).toBe(
      "Dernière période complète : 0 km · moyenne : 0 km · tendance : stable.",
    );
  });

  it("n'annonce pas de tendance avec une seule valeur", () => {
    expect(describeSeries(series("heartrate"), [null, 150])).not.toContain(
      "tendance",
    );
  });
});
