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
