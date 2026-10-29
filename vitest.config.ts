import { fileURLToPath } from "node:url";
import {
  defineWorkersConfig,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers/config";

// Les tests tournent dans workerd avec une base D1 locale vide par fichier de test.
export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(
    fileURLToPath(new URL("./migrations", import.meta.url)),
  );

  return {
    test: {
      include: ["src/**/*.test.ts"],
      poolOptions: {
        workers: {
          miniflare: {
            compatibilityDate: "2025-10-01",
            compatibilityFlags: ["nodejs_compat"],
            d1Databases: ["DB"],
            bindings: { TEST_MIGRATIONS: migrations },
          },
        },
      },
    },
  };
});
