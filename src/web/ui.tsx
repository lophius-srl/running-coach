export function Loading({ label }: { label: string }) {
  return (
    <p className="card state loading" role="status">
      <span className="spinner" aria-hidden="true" />
      {label}
    </p>
  );
}

// Erreur annoncée aux lecteurs d'écran et signalée par un libellé, pas seulement par la couleur.
export function Alert({ message }: { message: string }) {
  return (
    <p className="alert" role="alert">
      <span className="alert-label">Erreur :</span> {message}
    </p>
  );
}
