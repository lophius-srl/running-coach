import { describe, expect, it } from "vitest";
import {
  predictTimeS,
  trainingPaces,
  UNREALISTIC_TARGET_GAP,
  vdot,
  type PaceInput,
  type TrainingPaces,
} from "./paces";

// Objectif sur la distance de la référence, sans chrono visé.
function sameDistance(distanceM: number, timeS: number): PaceInput {
  return {
    distanceM,
    targetTimeS: null,
    referenceDistanceM: distanceM,
    referenceTimeS: timeS,
  };
}

function range(fast: number, slow: number) {
  return { fastSPerKm: fast, slowSPerKm: slow };
}

function allPaces(paces: TrainingPaces): number[] {
  return [paces.endurance, paces.threshold, paces.vma, paces.race].flatMap(
    (zone) => [zone.fastSPerKm, zone.slowSPerKm],
  );
}

// Valeurs calculées par les formules de Daniels (s/km). Comparées aux tables VDOT de
// « Daniels' Running Formula » : à ± 6 s/km près (seuil ≈ T, VMA encadre I, prédiction ≈ M).
describe("trainingPaces : cas de référence", () => {
  it("10 km en 50:00 (VDOT ≈ 40 ; tables : T 5:06, I 4:42, marathon 3:49:45)", () => {
    expect(vdot(10000, 3000)).toBeCloseTo(40, 1);
    expect(trainingPaces(sameDistance(10000, 3000))).toEqual({
      endurance: range(351, 389), // 5:51 – 6:29
      threshold: range(305, 320), // 5:05 – 5:20
      vma: range(276, 287), // 4:36 – 4:47
      race: range(297, 303), // 5:00 ± 1 %
      predictedTimeS: 3000,
      targetWarning: null,
    });
    expect(predictTimeS(vdot(10000, 3000), 42195)).toBe(13774); // 3:49:34
  });

  it("5 km en 20:00 (VDOT ≈ 50 ; tables : T 4:15, I 3:55)", () => {
    expect(vdot(5000, 1200)).toBeCloseTo(49.8, 1);
    expect(trainingPaces(sameDistance(5000, 1200))).toMatchObject({
      endurance: range(294, 327), // 4:54 – 5:27
      threshold: range(256, 268), // 4:16 – 4:28
      vma: range(231, 241), // 3:51 – 4:01
      race: range(238, 242), // 4:00 ± 1 %
      predictedTimeS: 1200,
    });
  });

  it("marathon en 3:30:00 (VDOT ≈ 44,6)", () => {
    expect(vdot(42195, 12600)).toBeCloseTo(44.55, 1);
    expect(trainingPaces(sameDistance(42195, 12600))).toMatchObject({
      endurance: range(322, 357), // 5:22 – 5:57
      threshold: range(280, 294), // 4:40 – 4:54
      vma: range(253, 263), // 4:13 – 4:23
      race: range(296, 302), // 4:59 ± 1 %
      predictedTimeS: 12600,
    });
  });
});

describe("trainingPaces : propriétés", () => {
  it("une référence plus rapide donne toutes les allures plus rapides", () => {
    const slower = allPaces(trainingPaces(sameDistance(10000, 3000)));
    const faster = allPaces(trainingPaces(sameDistance(10000, 2940)));
    faster.forEach((pace, index) => expect(pace).toBeLessThan(slower[index]));
  });

  it("ordonne les zones : VMA < seuil < endurance, chaque fourchette rapide ≤ lente", () => {
    const paces = trainingPaces(sameDistance(10000, 3000));
    expect(paces.vma.slowSPerKm).toBeLessThan(paces.threshold.fastSPerKm);
    expect(paces.threshold.slowSPerKm).toBeLessThan(paces.endurance.fastSPerKm);
    for (const zone of [paces.endurance, paces.threshold, paces.vma]) {
      expect(zone.fastSPerKm).toBeLessThan(zone.slowSPerKm);
    }
  });

  it("prend l'allure du chrono visé pour l'allure course", () => {
    const paces = trainingPaces({
      ...sameDistance(10000, 3000),
      targetTimeS: 2940,
    });
    expect(paces.race).toEqual(range(291, 297)); // 4:54 ± 1 %
  });

  it("prédit l'allure course sur une autre distance que la référence", () => {
    const paces = trainingPaces({
      distanceM: 42195,
      targetTimeS: null,
      referenceDistanceM: 10000,
      referenceTimeS: 3000,
    });
    expect(paces.predictedTimeS).toBe(13774);
    expect(paces.race).toEqual(range(323, 330)); // 5:26 ± 1 %
  });

  it.each([
    ["record du monde du 5 km", 5000, 755],
    ["5 km à 15 min/km", 5000, 4500],
    ["record du monde du marathon", 42195, 7235],
    ["marathon à 15 min/km", 42195, 37975],
  ])("reste fini et cohérent aux bornes : %s", (_, distanceM, timeS) => {
    const paces = trainingPaces(sameDistance(distanceM, timeS));
    expect(Math.abs(paces.predictedTimeS - timeS)).toBeLessThanOrEqual(1);
    for (const pace of allPaces(paces)) {
      expect(Number.isInteger(pace) && pace > 0).toBe(true);
    }
  });
});

describe("trainingPaces : chrono visé irréaliste", () => {
  // Référence 10 km en 50:00 → prédiction 3000 s sur 10 km.
  const atGap = (gap: number) =>
    trainingPaces({
      ...sameDistance(10000, 3000),
      targetTimeS: Math.round(3000 * (1 - gap)),
    }).targetWarning;

  it("fixe le seuil à 5 %", () => {
    expect(UNREALISTIC_TARGET_GAP).toBe(0.05);
  });

  it("n'avertit pas à 5 % pile ni en deçà", () => {
    expect(atGap(0.05)).toBeNull(); // 2850 s
    expect(atGap(0)).toBeNull();
    expect(atGap(-0.2)).toBeNull(); // plus lent que la prédiction
  });

  it("avertit au-delà de 5 %", () => {
    expect(atGap(0.0503)).toBe(
      "Ton chrono visé est 5 % plus rapide que ce que prédit ta référence.",
    ); // 2849 s
    expect(atGap(0.08)).toBe(
      "Ton chrono visé est 8 % plus rapide que ce que prédit ta référence.",
    );
  });

  it("n'avertit pas sans chrono visé", () => {
    expect(trainingPaces(sameDistance(10000, 3000)).targetWarning).toBeNull();
  });
});
