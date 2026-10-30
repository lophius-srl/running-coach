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

// Valeurs produites par les formules (s/km) ; T et I recoupés avec les valeurs de tables
// citées dans paces.ts.
describe("trainingPaces : cas de référence", () => {
  it("10 km en 50:00 (VDOT ≈ 40 ; tables : T 5:06, I 4:42, marathon 3:49:45)", () => {
    expect(vdot(10000, 3000)).toBeCloseTo(40, 1);
    expect(trainingPaces(sameDistance(10000, 3000))).toEqual({
      endurance: range(367, 403), // 6:07 – 6:43
      threshold: range(305, 311), // 5:05 – 5:11
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
      endurance: range(308, 339), // 5:08 – 5:39
      threshold: range(256, 261), // 4:16 – 4:21
      vma: range(231, 241), // 3:51 – 4:01
      race: range(238, 242), // 4:00 ± 1 %
      predictedTimeS: 1200,
    });
  });

  it("marathon en 3:30:00 (VDOT ≈ 44,6)", () => {
    expect(vdot(42195, 12600)).toBeCloseTo(44.55, 1);
    expect(trainingPaces(sameDistance(42195, 12600))).toMatchObject({
      endurance: range(337, 371), // 5:37 – 6:11
      threshold: range(280, 285), // 4:40 – 4:45
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
      "Ton chrono visé est au moins 5 % plus rapide que ce que prédit ta référence. Un objectif réaliste serait autour de 50:00.",
    ); // 2849 s, écart 5,03 %
    expect(atGap(0.08)).toBe(
      "Ton chrono visé est au moins 8 % plus rapide que ce que prédit ta référence. Un objectif réaliste serait autour de 50:00.",
    );
  });

  it("n'avertit pas sans chrono visé", () => {
    expect(trainingPaces(sameDistance(10000, 3000)).targetWarning).toBeNull();
  });
});

// Bornes acceptées par validateGoal : record du monde … 15 min/km, sur chaque distance.
const DISTANCES_M = [5000, 10000, 21098, 42195];
const WORLD_RECORDS_S: Record<number, number> = {
  5000: 755,
  10000: 1571,
  21098: 3402,
  42195: 7235,
};
const slowestTimeS = (distanceM: number) => Math.floor(distanceM * 0.9);

// Chronos de référence du record du monde à 15 min/km, en 12 paliers.
function referenceTimes(distanceM: number): number[] {
  const fastest = WORLD_RECORDS_S[distanceM];
  const step = (slowestTimeS(distanceM) - fastest) / 12;
  return Array.from({ length: 13 }, (_, i) => Math.round(fastest + i * step));
}

function zonesInOrder(paces: TrainingPaces) {
  return [paces.vma, paces.threshold, paces.endurance];
}

describe("trainingPaces : déterminisme et domaine de saisie", () => {
  it("renvoie le même résultat pour la même saisie, sans la modifier", () => {
    const input: PaceInput = {
      distanceM: 42195,
      targetTimeS: 13500,
      referenceDistanceM: 10000,
      referenceTimeS: 3000,
    };
    const frozen = Object.freeze({ ...input });

    expect(trainingPaces(frozen)).toEqual(trainingPaces(input));
    expect(input).toEqual(frozen);
  });

  it.each(DISTANCES_M)(
    "ralentit chaque allure et la prédiction quand la référence sur %i m ralentit",
    (referenceDistanceM) => {
      const results = referenceTimes(referenceDistanceM).map((referenceTimeS) =>
        trainingPaces({
          distanceM: 21098,
          targetTimeS: null,
          referenceDistanceM,
          referenceTimeS,
        }),
      );
      for (let i = 1; i < results.length; i++) {
        const slower = allPaces(results[i]);
        allPaces(results[i - 1]).forEach((pace, index) =>
          expect(pace).toBeLessThan(slower[index]),
        );
        expect(results[i].predictedTimeS).toBeGreaterThan(
          results[i - 1].predictedTimeS,
        );
      }
    },
  );

  it.each(DISTANCES_M)(
    "garde VMA < seuil < endurance et rapide < lente sur tout le domaine (référence %i m)",
    (referenceDistanceM) => {
      for (const referenceTimeS of referenceTimes(referenceDistanceM)) {
        const paces = trainingPaces(
          sameDistance(referenceDistanceM, referenceTimeS),
        );
        const zones = zonesInOrder(paces);
        for (const zone of [...zones, paces.race]) {
          expect(zone.fastSPerKm).toBeLessThan(zone.slowSPerKm);
        }
        for (let i = 1; i < zones.length; i++) {
          expect(zones[i - 1].slowSPerKm).toBeLessThan(zones[i].fastSPerKm);
        }
      }
    },
  );

  // La dichotomie doit converger à l'intérieur de [1 min, 50 h], pour toute paire de distances.
  it.each(
    DISTANCES_M.flatMap((referenceDistanceM) =>
      DISTANCES_M.flatMap((distanceM) =>
        [
          WORLD_RECORDS_S[referenceDistanceM],
          slowestTimeS(referenceDistanceM),
        ].map((referenceTimeS) => ({
          referenceDistanceM,
          referenceTimeS,
          distanceM,
        })),
      ),
    ),
  )(
    "prédit un chrono fini et cohérent : référence $referenceDistanceM m en $referenceTimeS s → $distanceM m",
    ({ referenceDistanceM, referenceTimeS, distanceM }) => {
      const score = vdot(referenceDistanceM, referenceTimeS);
      const predicted = predictTimeS(score, distanceM);

      expect(Number.isSafeInteger(predicted)).toBe(true);
      expect(predicted).toBeGreaterThan(60);
      expect(predicted).toBeLessThan(3000 * 60);
      expect(vdot(distanceM, predicted)).toBeCloseTo(score, 1);
      const paces = trainingPaces({
        distanceM,
        targetTimeS: null,
        referenceDistanceM,
        referenceTimeS,
      });
      for (const pace of allPaces(paces)) {
        expect(Number.isSafeInteger(pace) && pace > 0).toBe(true);
      }
    },
  );

  it("prédit un chrono plus long sur une distance plus longue", () => {
    const score = vdot(10000, 3000);
    const predictions = DISTANCES_M.map((distanceM) =>
      predictTimeS(score, distanceM),
    );
    expect(predictions).toEqual([...predictions].sort((a, b) => a - b));
    expect(new Set(predictions).size).toBe(DISTANCES_M.length);
  });
});

// Source publiée (V.O2 / Jack Daniels, « What's your interval pace? », 05/02/2013,
// news.vdoto2.com) : semi en 1:50 → allure I « roughly 7:29 per mile » ≈ 4:39/km.
describe("trainingPaces : calage sur une valeur publiée par Daniels", () => {
  it("encadre l'allure I officielle d'un semi en 1:50:00 dans la zone VMA", () => {
    const officialIntervalSPerKm = Math.round((7 * 60 + 29) / 1.609344); // 279 s
    const { vma } = trainingPaces(sameDistance(21098, 6600));

    expect(vma.fastSPerKm).toBeLessThanOrEqual(officialIntervalSPerKm);
    expect(vma.slowSPerKm).toBeGreaterThanOrEqual(officialIntervalSPerKm);
  });
});

describe("trainingPaces : avertissement entre distances différentes", () => {
  // Référence 10 km en 50:00 → marathon prédit en 13 774 s ; 5 % plus rapide = 13 085,3 s.
  const marathonTarget = (targetTimeS: number | null) =>
    trainingPaces({
      distanceM: 42195,
      targetTimeS,
      referenceDistanceM: 10000,
      referenceTimeS: 3000,
    }).targetWarning;

  it("n'avertit pas juste en deçà de 5 % (13 086 s, écart 4,998 %)", () => {
    expect(marathonTarget(13086)).toBeNull();
  });

  it("avertit juste au-delà de 5 % (13 085 s, écart 5,002 %)", () => {
    expect(marathonTarget(13085)).toBe(
      "Ton chrono visé est au moins 5 % plus rapide que ce que prédit ta référence. Un objectif réaliste serait autour de 3:49:34.",
    );
  });

  it("n'avertit pas pour un chrono visé égal ou plus lent que la prédiction", () => {
    expect(marathonTarget(13774)).toBeNull();
    expect(marathonTarget(16200)).toBeNull();
  });

  it("garde l'allure du chrono visé même quand il est jugé irréaliste", () => {
    const paces = trainingPaces({
      distanceM: 42195,
      targetTimeS: 10800, // 3:00:00, écart 21,6 %
      referenceDistanceM: 10000,
      referenceTimeS: 3000,
    });
    expect(paces.race).toEqual(range(253, 259)); // 4:16/km ± 1 %
    expect(paces.targetWarning).toBe(
      "Ton chrono visé est au moins 21 % plus rapide que ce que prédit ta référence. Un objectif réaliste serait autour de 3:49:34.",
    );
  });
});
