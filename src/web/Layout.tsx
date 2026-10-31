import type { ReactNode } from "react";
import { APP_NAME } from "./routes";

// Logo officiel « Powered by Strava », en noir sur thème clair et en blanc sur thème sombre.
function PoweredByStrava() {
  return (
    <picture>
      <source
        srcSet="/strava/api_logo_pwrdBy_strava_horiz_white.svg"
        media="(prefers-color-scheme: dark)"
      />
      <img
        className="powered-by"
        src="/strava/api_logo_pwrdBy_strava_horiz_black.svg"
        width={365}
        height={37}
        alt="Powered by Strava"
      />
    </picture>
  );
}

type Props = { actions?: ReactNode; nav?: ReactNode; children: ReactNode };

// Avec navigation (connecté), le titre principal (h1) est celui de la vue : le nom de l'app
// n'est alors qu'un libellé. Sans navigation (accueil), il reste le titre de la page.
export function Layout({ actions, nav, children }: Props) {
  const Brand = nav ? "p" : "h1";
  return (
    <div className={nav ? "layout layout-app" : "layout"}>
      <header className="app-header">
        <Brand className="app-title">{APP_NAME}</Brand>
        {actions}
      </header>
      {nav}
      <main>{children}</main>
      <footer className="app-footer">
        <PoweredByStrava />
      </footer>
    </div>
  );
}
