// Routage maison de l'app connectée (issues #50, #55, #61) : cinq vues, une URL chacune, sans dépendance.
// Fonctions pures, testées dans routes.test.ts ; l'historique du navigateur est géré par useRoute.

export type ViewId = "week" | "plan" | "goal" | "progression" | "history";

export type Route = {
  view: ViewId;
  path: string;
  label: string; // libellé de l'onglet et titre de la vue
  shortLabel?: string; // libellé de l'onglet sur la barre du bas (mobile), si label est trop long
};

export const ROUTES: readonly Route[] = [
  // Barre du bas à 320 px : 5 onglets de 64 px, libellés courts sur une ligne.
  { view: "week", path: "/", label: "Ma semaine", shortLabel: "Semaine" },
  { view: "plan", path: "/plan", label: "Mon plan", shortLabel: "Plan" },
  {
    view: "goal",
    path: "/objectif",
    label: "Objectif & allures",
    shortLabel: "Objectif",
  },
  {
    view: "progression",
    path: "/progression",
    label: "Progression",
    shortLabel: "Progrès",
  },
  {
    view: "history",
    path: "/historique",
    label: "Historique",
    shortLabel: "Import",
  },
];

export const APP_NAME = "Running Coach";

// Chemin → vue. Barre oblique finale et casse ignorées ; chemin inconnu → Ma semaine.
export function viewForPath(pathname: string): ViewId {
  const normalized = pathname.replace(/\/+$/, "").toLowerCase() || "/";
  return ROUTES.find((route) => route.path === normalized)?.view ?? "week";
}

export function routeFor(view: ViewId): Route {
  return ROUTES.find((route) => route.view === view) ?? ROUTES[0];
}

export function documentTitle(view: ViewId): string {
  return `${routeFor(view).label} · ${APP_NAME}`;
}

type ClickLike = {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
};

// Seul un clic gauche simple est intercepté : ctrl/cmd/shift/alt-clic et clic milieu gardent
// le comportement natif du navigateur (nouvel onglet, nouvelle fenêtre, téléchargement).
export function isPlainLeftClick(event: ClickLike): boolean {
  return (
    event.button === 0 &&
    !event.defaultPrevented &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}
