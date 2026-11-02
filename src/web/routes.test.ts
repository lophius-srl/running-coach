import { describe, expect, it } from "vitest";
import {
  documentTitle,
  isPlainLeftClick,
  routeFor,
  ROUTES,
  viewForPath,
} from "./routes";

describe("viewForPath", () => {
  it.each([
    ["/", "week"],
    ["/plan", "plan"],
    ["/objectif", "goal"],
    ["/historique", "history"],
  ] as const)("associe %s à la vue %s", (path, view) => {
    expect(viewForPath(path)).toBe(view);
  });

  it("ignore la barre oblique finale et la casse", () => {
    expect(viewForPath("/objectif/")).toBe("goal");
    expect(viewForPath("/Historique//")).toBe("history");
    expect(viewForPath("/Plan/")).toBe("plan");
  });

  it("renvoie Ma semaine pour un chemin inconnu ou vide", () => {
    expect(viewForPath("/inconnu")).toBe("week");
    expect(viewForPath("/objectif/detail")).toBe("week");
    expect(viewForPath("/plan/semaine")).toBe("week");
    expect(viewForPath("/plans")).toBe("week");
    expect(viewForPath("/planning")).toBe("week");
    expect(viewForPath("")).toBe("week");
  });

  it("retrouve chaque vue à partir de son propre chemin", () => {
    for (const route of ROUTES) {
      expect(viewForPath(route.path)).toBe(route.view);
      expect(routeFor(route.view)).toBe(route);
    }
  });
});

describe("ROUTES", () => {
  it("propose quatre onglets, Mon plan juste après Ma semaine", () => {
    expect(ROUTES.map(({ view, path }) => [view, path])).toEqual([
      ["week", "/"],
      ["plan", "/plan"],
      ["goal", "/objectif"],
      ["history", "/historique"],
    ]);
  });

  it("a des chemins canoniques : minuscules, sans barre oblique finale", () => {
    for (const { path } of ROUTES) {
      expect(path).toMatch(/^\/[a-z]*$/);
    }
  });

  it("a des chemins et des libellés uniques", () => {
    expect(new Set(ROUTES.map((route) => route.path)).size).toBe(ROUTES.length);
    expect(new Set(ROUTES.map((route) => route.label)).size).toBe(
      ROUTES.length,
    );
  });
});

describe("documentTitle", () => {
  it("préfixe le nom de l'app par le titre de la vue", () => {
    expect(documentTitle("goal")).toBe("Objectif & allures · Running Coach");
    expect(documentTitle("plan")).toBe("Mon plan · Running Coach");
  });
});

describe("isPlainLeftClick", () => {
  const click = {
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
  };

  it("intercepte un clic gauche simple", () => {
    expect(isPlainLeftClick(click)).toBe(true);
  });

  it.each(["metaKey", "ctrlKey", "shiftKey", "altKey"] as const)(
    "laisse le navigateur gérer le clic avec %s",
    (key) => {
      expect(isPlainLeftClick({ ...click, [key]: true })).toBe(false);
    },
  );

  it("laisse passer le clic milieu et un clic déjà traité", () => {
    expect(isPlainLeftClick({ ...click, button: 1 })).toBe(false);
    expect(isPlainLeftClick({ ...click, defaultPrevented: true })).toBe(false);
  });
});
