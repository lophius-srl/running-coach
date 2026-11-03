// QA de l'issue #69 : deleteWatchData sur R2, cas limites (préfixe exact, > 1 000 objets).
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDatabase } from "../test-db";
import { deleteWatchData, R2_DELETE_BATCH } from "./delete";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

async function allKeys(): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.FIT_BUCKET.list({ cursor });
    keys.push(...page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return keys.sort();
}

beforeEach(async () => {
  await resetDatabase(env.DB);
  const keys = await allKeys();
  for (let i = 0; i < keys.length; i += R2_DELETE_BATCH) {
    await env.FIT_BUCKET.delete(keys.slice(i, i + R2_DELETE_BATCH));
  }
  vi.restoreAllMocks();
});

async function putFiles(prefix: string, count: number) {
  const writes: Promise<unknown>[] = [];
  for (let n = 0; n < count; n += 1) {
    const key = `${prefix}${n.toString(16).padStart(64, "0")}.fit`;
    writes.push(env.FIT_BUCKET.put(key, new Uint8Array([1])));
  }
  await Promise.all(writes);
}

describe("deleteWatchData : R2", () => {
  it("efface plus de 1 000 objets, par lots de 1 000 clés au plus", async () => {
    await putFiles("fit/1/", R2_DELETE_BATCH + 5);
    const remove = vi.spyOn(env.FIT_BUCKET, "delete");

    await deleteWatchData(env, 1);

    expect(await allKeys()).toEqual([]);
    const batches = remove.mock.calls.map(
      ([keys]) => (keys as string[]).length,
    );
    expect(batches).toEqual([R2_DELETE_BATCH, 5]);
  });

  it("n'efface que le préfixe exact (fit/1/ ne touche ni fit/10/ ni fit/1x ni fit/11/)", async () => {
    await putFiles("fit/1/", 2);
    await env.FIT_BUCKET.put("fit/10/a.fit", new Uint8Array([1]));
    await env.FIT_BUCKET.put("fit/11/b.fit", new Uint8Array([1]));
    await env.FIT_BUCKET.put("fit/1x.fit", new Uint8Array([1]));
    await env.FIT_BUCKET.put("other/1/c.fit", new Uint8Array([1]));

    await deleteWatchData(env, 1);

    expect(await allKeys()).toEqual([
      "fit/10/a.fit",
      "fit/11/b.fit",
      "fit/1x.fit",
      "other/1/c.fit",
    ]);
  });

  it("ne dépasse jamais 1 000 clés par appel, même avec une page demandée plus grande", async () => {
    await putFiles("fit/1/", R2_DELETE_BATCH + 1);
    const remove = vi.spyOn(env.FIT_BUCKET, "delete");

    await deleteWatchData(env, 1, 5000);

    for (const [keys] of remove.mock.calls) {
      expect((keys as string[]).length).toBeLessThanOrEqual(R2_DELETE_BATCH);
    }
    expect(await allKeys()).toEqual([]);
  });

  it("efface tout l'utilisateur et laisse l'autre intact, deux fois de suite", async () => {
    await env.DB.prepare(
      "INSERT INTO users (id, strava_athlete_id) VALUES (1, 42), (2, 43)",
    ).run();
    await putFiles("fit/1/", 3);
    await putFiles("fit/2/", 3);

    await deleteWatchData(env, 1);
    await deleteWatchData(env, 1);

    expect(await allKeys()).toHaveLength(3);
    expect((await allKeys()).every((key) => key.startsWith("fit/2/"))).toBe(
      true,
    );
  });
});
