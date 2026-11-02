import { describe, expect, it } from "vitest";
import { labelIndices, niceTicks, summarize } from "./scale";

describe("niceTicks", () => {
  it("donne des graduations rondes qui couvrent le minimum et le maximum", () => {
    expect(niceTicks(0, 57)).toEqual([0, 20, 40, 60]);
    expect(niceTicks(0, 1040)).toEqual([0, 500, 1000, 1500]);
  });

  it("couvre un maximum qui n'est pas un multiple du pas (FC 161)", () => {
    const ticks = niceTicks(150, 161);
    expect(ticks[0]).toBeLessThanOrEqual(150);
    expect(ticks.at(-1)).toBeGreaterThanOrEqual(161);
    expect(ticks.every(Number.isInteger)).toBe(true);
  });

  it("élargit une série constante et se replie sur [0, 1] sans valeur", () => {
    const ticks = niceTicks(300, 300);
    expect(ticks[0]).toBeLessThan(300);
    expect(ticks.at(-1)).toBeGreaterThan(300);
    expect(niceTicks(Infinity, -Infinity)).toEqual([0, 1]);
  });
});

describe("labelIndices", () => {
  it("étiquette au plus `max` périodes, la dernière toujours", () => {
    expect(labelIndices(26, 4)).toEqual([4, 11, 18, 25]);
    expect(labelIndices(3, 10)).toEqual([0, 1, 2]);
    expect(labelIndices(0, 4)).toEqual([]);
  });
});

describe("summarize", () => {
  it("ignore les trous et compare la 2e moitié à la 1re", () => {
    expect(summarize([10, null, 10, 20, 20])).toEqual({
      last: 20,
      mean: 15,
      trend: "up",
    });
    expect(summarize([300, 290, 300, 291]).trend).toBe("flat");
    expect(summarize([40, 40, 30, 30]).trend).toBe("down");
  });

  it("n'a ni moyenne ni tendance sans valeur, pas de tendance avec une seule", () => {
    expect(summarize([null, null])).toEqual({
      last: null,
      mean: null,
      trend: null,
    });
    expect(summarize([5]).trend).toBeNull();
  });
});

// --- QA #61 ---

describe("niceTicks : couverture", () => {
  // Générateur déterministe (pas de Math.random : tests reproductibles).
  function* ranges() {
    let seed = 12345;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let i = 0; i < 500; i++) {
      const scale = 10 ** Math.floor(next() * 7 - 2);
      const a = next() * scale;
      const b = a + next() * scale;
      yield [a, b] as const;
    }
  }

  it("couvre toujours [min, max] avec des pas réguliers, quelle que soit l'échelle", () => {
    for (const [min, max] of ranges()) {
      const ticks = niceTicks(min, max);
      expect(ticks[0]).toBeLessThanOrEqual(min);
      expect(ticks.at(-1)).toBeGreaterThanOrEqual(max);
      expect(ticks.length).toBeGreaterThanOrEqual(2);
      expect(ticks.length).toBeLessThanOrEqual(10);
    }
  });

  it("couvre un volume hebdomadaire réel (0 à 87 340 m)", () => {
    const ticks = niceTicks(0, 87_340);
    expect(ticks[0]).toBe(0);
    expect(ticks.at(-1)).toBe(100_000);
  });

  it("encadre une seule valeur d'allure", () => {
    const ticks = niceTicks(287, 287);
    expect(ticks[0]).toBeLessThan(287);
    expect(ticks.at(-1)).toBeGreaterThan(287);
  });
});

describe("summarize : cas limites", () => {
  it("donne une tendance stable pour une série de zéros", () => {
    expect(summarize([0, 0, 0, 0])).toEqual({
      last: 0,
      mean: 0,
      trend: "flat",
    });
  });

  it("voit une hausse depuis zéro", () => {
    expect(summarize([0, 0, 5, 5]).trend).toBe("up");
  });

  it("garde la dernière valeur connue quand la série finit par des trous", () => {
    expect(summarize([300, 310, null, null]).last).toBe(310);
  });
});
