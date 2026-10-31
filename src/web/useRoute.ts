import { useEffect, useState } from "react";
import { routeFor, viewForPath, type ViewId } from "./routes";

const currentView = () => viewForPath(window.location.pathname);

// Change d'URL sans recharger la page. L'événement popstate émis notifie useRoute comme le ferait
// le bouton « précédent » du navigateur, sans avoir à transmettre de callback aux composants.
export function navigateTo(view: ViewId) {
  const { path } = routeFor(view);
  if (window.location.pathname !== path) {
    window.history.pushState(null, "", path);
  }
  window.dispatchEvent(new PopStateEvent("popstate"));
}

// Vue affichée, d'après l'URL ; suit les navigations internes et l'historique du navigateur.
export function useRoute(): ViewId {
  const [view, setView] = useState<ViewId>(currentView);

  useEffect(() => {
    const onPopState = () => setView(currentView());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  return view;
}
