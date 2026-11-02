// Graphiques SVG maison (issue #61), sans dépendance : barres et ligne, mêmes axes et mêmes
// interactions. La valeur de la période choisie (survol, toucher, flèches du clavier) s'affiche
// au-dessus du tracé ; le résumé texte (dernière valeur, moyenne, tendance) est donné par l'appelant.

import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { labelIndices, niceTicks } from "./scale";

export type ChartPoint = {
  label: string; // libellé court de l'axe des x
  detail: string; // période complète, affichée avec la valeur
  value: number | null; // null : trou dans la ligne
};

type Props = {
  title: string;
  points: readonly ChartPoint[];
  format: (value: number) => string;
  axisFormat?: (value: number) => string; // graduations de l'axe des y, sans unité
  minSpan?: number; // étendue minimale de l'axe des barres (ex. 1 000 m) quand tout est à 0
  summary: string;
  inverted?: boolean; // axe inversé : petite valeur en haut (allure)
};

const HEIGHT = 168;
const MARGIN = { top: 10, right: 10, bottom: 24, left: 44 };
const LABEL_SPACING = 64; // px minimum entre deux libellés de l'axe des x

// Largeur réelle du tracé : le texte du SVG garde sa taille, quel que soit l'écran.
function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(320);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.max(200, Math.round(entry.contentRect.width))),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

// Segments continus de la ligne (les null coupent le tracé).
function segments(coords: ({ x: number; y: number } | null)[]) {
  const result: { x: number; y: number }[][] = [[]];
  for (const point of coords) {
    if (point) result[result.length - 1].push(point);
    else if (result[result.length - 1].length > 0) result.push([]);
  }
  return result.filter((segment) => segment.length > 0);
}

function Chart(props: Props & { kind: "bar" | "line" }) {
  const { kind, title, points, format, summary, inverted } = props;
  const axisFormat = props.axisFormat ?? format;
  const { ref, width } = useWidth();
  const [active, setActive] = useState<number | null>(null);
  const titleId = useId();
  const readoutId = useId();
  const hintId = useId();

  const values = points
    .map((p) => p.value)
    .filter((v): v is number => v !== null);
  // Ligne sans aucune valeur : ni graduations ni tracé, seulement un message.
  const empty = kind === "line" && values.length === 0;
  const ticks = empty
    ? []
    : kind === "bar"
      ? niceTicks(0, Math.max(props.minSpan ?? 1, ...values))
      : niceTicks(Math.min(...values), Math.max(...values));
  const [low, high] = empty ? [0, 1] : [ticks[0], ticks[ticks.length - 1]];
  const plotW = width - MARGIN.left - MARGIN.right;
  const plotH = HEIGHT - MARGIN.top - MARGIN.bottom;
  const band = plotW / Math.max(1, points.length);
  const x = (i: number) => MARGIN.left + band * (i + 0.5);
  const y = (v: number) => {
    const share = (v - low) / (high - low || 1);
    return MARGIN.top + plotH * (inverted ? share : 1 - share);
  };

  const shown = active ?? points.length - 1;
  const current = points[shown];
  const readout = current
    ? `${current.detail} : ${current.value === null ? "pas de donnée" : format(current.value)}`
    : "";

  function pick(event: PointerEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const svgX = ((event.clientX - rect.left) * width) / rect.width;
    const index = Math.floor((svgX - MARGIN.left) / band);
    setActive(Math.min(points.length - 1, Math.max(0, index)));
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const moves: Record<string, number> = {
      ArrowLeft: shown - 1,
      ArrowRight: shown + 1,
      Home: 0,
      End: points.length - 1,
    };
    if (!(event.key in moves)) return;
    event.preventDefault();
    setActive(Math.min(points.length - 1, Math.max(0, moves[event.key])));
  }

  const coords = points.map((p, i) =>
    p.value === null ? null : { x: x(i), y: y(p.value) },
  );
  const barWidth = Math.max(1, band * (points.length > 60 ? 1 : 0.7));

  return (
    <figure className="chart card">
      <h3 id={titleId} className="chart-title">
        {title}
      </h3>
      <p id={readoutId} className="chart-readout" aria-live="polite">
        {readout}
      </p>
      <div
        ref={ref}
        className="chart-plot"
        tabIndex={0}
        role="group"
        aria-labelledby={titleId}
        aria-describedby={`${readoutId} ${hintId}`}
        onKeyDown={onKeyDown}
      >
        <svg
          role="img"
          aria-label={`${title}. ${summary}`}
          viewBox={`0 0 ${width} ${HEIGHT}`}
          width="100%"
          height={HEIGHT}
          onPointerDown={pick}
          onPointerMove={pick}
          onPointerLeave={(event) =>
            event.pointerType === "mouse" && setActive(null)
          }
        >
          {ticks.map((tick) => (
            <g key={tick} className="chart-grid">
              <line
                x1={MARGIN.left}
                x2={width - MARGIN.right}
                y1={y(tick)}
                y2={y(tick)}
              />
              <text
                x={MARGIN.left - 6}
                y={y(tick)}
                dy="0.32em"
                textAnchor="end"
              >
                {axisFormat(tick)}
              </text>
            </g>
          ))}
          {labelIndices(points.length, Math.floor(plotW / LABEL_SPACING)).map(
            (i) => (
              <text
                key={i}
                className="chart-axis"
                x={Math.min(
                  Math.max(x(i), MARGIN.left + 16),
                  width - MARGIN.right - 16,
                )}
                y={HEIGHT - 6}
                textAnchor="middle"
              >
                {points[i].label}
              </text>
            ),
          )}
          {empty && (
            <text
              className="chart-axis"
              x={MARGIN.left + plotW / 2}
              y={MARGIN.top + plotH / 2}
              textAnchor="middle"
            >
              Aucune donnée sur la période
            </text>
          )}
          <line
            className="chart-cursor"
            x1={x(shown)}
            x2={x(shown)}
            y1={MARGIN.top}
            y2={MARGIN.top + plotH}
          />
          {kind === "bar"
            ? coords.map(
                (c, i) =>
                  c && (
                    <rect
                      key={i}
                      className={
                        i === shown ? "chart-bar chart-active" : "chart-bar"
                      }
                      x={c.x - barWidth / 2}
                      y={c.y}
                      width={barWidth}
                      height={MARGIN.top + plotH - c.y}
                    />
                  ),
              )
            : segments(coords).map((segment, i) =>
                segment.length === 1 ? (
                  <circle
                    key={i}
                    className="chart-dot"
                    cx={segment[0].x}
                    cy={segment[0].y}
                    r={2.5}
                  />
                ) : (
                  <polyline
                    key={i}
                    className="chart-line"
                    points={segment.map((p) => `${p.x},${p.y}`).join(" ")}
                  />
                ),
              )}
          {kind === "line" && coords[shown] && (
            <circle
              className="chart-dot chart-active"
              cx={coords[shown].x}
              cy={coords[shown].y}
              r={4}
            />
          )}
        </svg>
      </div>
      <span id={hintId} className="visually-hidden">
        Flèches gauche et droite pour parcourir les périodes.
      </span>
      <figcaption className="chart-summary muted">{summary}</figcaption>
    </figure>
  );
}

export function BarChart(props: Props) {
  return <Chart kind="bar" {...props} />;
}

export function LineChart(props: Props) {
  return <Chart kind="line" {...props} />;
}
