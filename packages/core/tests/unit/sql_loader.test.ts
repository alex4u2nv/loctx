import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadQueries, SqlLoadError } from "../../src/sql/loader.js";
import { mkTmpDir, rmTmpDir } from "../helpers/tmp.js";

let tmp: string;
beforeEach(() => {
  tmp = mkTmpDir();
});
afterEach(() => {
  rmTmpDir(tmp);
});

describe("loadQueries against bundled state.sql", () => {
  it("exposes expected sections", () => {
    const queries = loadQueries("../../src/sql/state.sql", import.meta.url);
    const expected = [
      "schema_v1",
      "pragma_enable_foreign_keys",
      "pragma_journal_wal",
      "pragma_get_user_version",
      "upsert_project",
      "get_project",
      "mark_project_indexed",
      "upsert_file",
      "get_file",
      "list_files",
      "delete_file",
      "delete_chunks_for_file",
      "insert_chunk",
      "list_chunks",
      "get_collection_identity",
      "insert_collection",
    ];
    for (const name of expected) {
      expect(typeof queries[name]).toBe("string");
      expect(queries[name]?.length).toBeGreaterThan(0);
    }
  });
});

describe("loadQueries with synthetic files", () => {
  it("rejects duplicate section names", () => {
    const path = join(tmp, "dup.sql");
    writeFileSync(path, "-- :name a\nSELECT 1;\n-- :name a\nSELECT 2;\n");
    expect(() => loadQueries("./dup.sql", `${pathToFileURL(tmp).href}/`)).toThrow(SqlLoadError);
  });

  it("treats text before first marker as header", () => {
    const path = join(tmp, "with_header.sql");
    writeFileSync(path, "-- file header\n-- random\n\n-- :name only\nSELECT 1;\n");
    const queries = loadQueries("./with_header.sql", `${pathToFileURL(tmp).href}/`);
    expect(Object.keys(queries)).toEqual(["only"]);
    expect(queries["only"]).toBe("SELECT 1;");
  });
});
