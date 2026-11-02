// Échelles des graphiques SVG maison (fonctions pures, testées sans React).

// Pas « ronds » : 1, 2, 5 × 10^n (pas de 2,5 : les graduations entières restent entières).
function niceStep(rough: number): number {
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].find((m) => m * power >= rough) ?? 10;
  return step * power;
}

// Environ `count` graduations rondes couvrant [min, max] ; la première et la dernière bornent l'axe.
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (max === min) {
    const pad = Math.max(1, Math.abs(max) * 0.05);
    return niceTicks(min - pad, max + pad, count);
  }
  const step = niceStep((max - min) / count);
  const first = Math.floor(min / step);
  const last = Math.ceil(max / step); // la dernière graduation couvre toujours le maximum
  const ticks: number[] = [];
  for (let k = first; k <= last; k++)
    ticks.push(Math.round(k * step * 1e6) / 1e6);
  return ticks;
}

// Indices à étiqueter sur l'axe des x : au plus `max`, régulièrement, la dernière période toujours.
export function labelIndices(length: number, max: number): number[] {
  const step = Math.max(1, Math.ceil(length / Math.max(1, max)));
  const indices: number[] = [];
  for (let i = length - 1; i >= 0; i -= step) indices.unshift(i);
  return indices;
}

export type Trend = "up" | "down" | "flat";

export type Summary = {
  last: number | null;
  mean: number | null;
  trend: Trend | null;
};

// Dernière valeur connue, moyenne et tendance (moyenne de la 2e moitié contre la 1re, ±5 %).
export function summarize(values: readonly (number | null)[]): Summary {
  const known = values.filter((v): v is number => v !== null);
  if (known.length === 0) return { last: null, mean: null, trend: null };
  const mean = (list: number[]) =>
    list.reduce((a, b) => a + b, 0) / list.length;
  const half = Math.floor(known.length / 2);
  let trend: Trend | null = null;
  if (half > 0) {
    const before = mean(known.slice(0, half));
    const after = mean(known.slice(known.length - half));
    const change =
      before === 0 ? (after > 0 ? 1 : 0) : (after - before) / before;
    trend = change > 0.05 ? "up" : change < -0.05 ? "down" : "flat";
  }
  return { last: known[known.length - 1], mean: mean(known), trend };
}
