import type { D1Migration } from "cloudflare:test";
import type { Bindings } from "./index";

declare global {
  namespace Cloudflare {
    interface Env extends Bindings {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
