import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Les tests tournent dans workerd avec une base D1 locale vide par fichier de test, et un bucket R2
// local (miniflare) pour les fichiers FIT.
export default defineConfig(async () => {
  const migrations = await readD1Migrations(
    fileURLToPath(new URL("./migrations", import.meta.url)),
  );

  return {
    plugins: [
      cloudflareTest({
        miniflare: {
          compatibilityDate: "2025-10-01",
          compatibilityFlags: ["nodejs_compat"],
          d1Databases: ["DB"],
          r2Buckets: ["FIT_BUCKET"],
          bindings: { TEST_MIGRATIONS: migrations },
        },
      }),
    ],
    // Fixtures FIT binaires importées en data URL base64 (`?inline`) par les tests de src/core/fit.
    assetsInclude: ["**/*.fit"],
    test: {
      include: ["src/**/*.test.ts"],
    },
  };
});
