import type { MouseEvent, ReactNode } from "react";
import { isPlainLeftClick, routeFor, ROUTES, type ViewId } from "./routes";
import { navigateTo } from "./useRoute";

type LinkProps = {
  view: ViewId;
  className?: string;
  current?: boolean;
  children: ReactNode;
};

// Vrai lien (href) : ctrl/cmd-clic et clic milieu ouvrent la vue dans un nouvel onglet.
export function RouteLink({ view, className, current, children }: LinkProps) {
  function onClick(event: MouseEvent<HTMLAnchorElement>) {
    if (!isPlainLeftClick(event)) return;
    event.preventDefault();
    navigateTo(view);
  }
  return (
    <a
      href={routeFor(view).path}
      className={className}
      aria-current={current ? "page" : undefined}
      onClick={onClick}
    >
      {children}
    </a>
  );
}

// Pictogrammes décoratifs (24 × 24, trait) : calendrier, cible, histogramme.
const ICONS: Record<ViewId, ReactNode> = {
  week: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </>
  ),
  goal: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1" />
    </>
  ),
  history: <path d="M4 20h16M7 16v-5M12 16V6M17 16v-8" />,
};

export function AppNav({ current }: { current: ViewId }) {
  return (
    <nav className="app-nav" aria-label="Navigation principale">
      <ul className="app-nav-list">
        {ROUTES.map(({ view, label }) => (
          <li key={view}>
            <RouteLink
              view={view}
              className="app-nav-link"
              current={view === current}
            >
              <svg
                className="app-nav-icon"
                viewBox="0 0 24 24"
                aria-hidden="true"
                focusable="false"
              >
                {ICONS[view]}
              </svg>
              {label}
            </RouteLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
