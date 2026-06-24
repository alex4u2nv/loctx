import { describe, expect, it } from "vitest";
import { parseCorpusToml, TomlParseError } from "../src/toml.js";

describe("parseCorpusToml", () => {
  it("parses the required fields", () => {
    const text = `
# v1 corpus
[corpus]
name = "loctx-self"
repo = "https://github.com/galexia/loctx"
sha = "0648fcf"
index_config = "default"
`;
    const c = parseCorpusToml(text);
    expect(c.name).toBe("loctx-self");
    expect(c.sha).toBe("0648fcf");
    expect(c.indexConfig).toBe("default");
  });

  it("defaults index_config when omitted", () => {
    const text = `[corpus]
name = "x"
repo = "y"
sha = "z"`;
    expect(parseCorpusToml(text).indexConfig).toBe("default");
  });

  it("rejects missing [corpus] table", () => {
    expect(() => parseCorpusToml(`[other]\nkey = "v"`)).toThrowError(TomlParseError);
  });

  it("rejects missing required keys", () => {
    expect(() => parseCorpusToml(`[corpus]\nname = "x"`)).toThrowError(/repo/);
  });

  it("rejects unquoted values", () => {
    const text = `[corpus]
name = bare
repo = "y"
sha = "z"`;
    expect(() => parseCorpusToml(text)).toThrowError(/quoted string/);
  });

  it("rejects top-level keys outside any table", () => {
    expect(() => parseCorpusToml(`name = "x"`)).toThrowError(/outside any \[table\]/);
  });

  it("strips line comments outside strings only", () => {
    const text = `[corpus]
name = "has #hash inside" # trailing comment
repo = "y"
sha = "z"`;
    expect(parseCorpusToml(text).name).toBe("has #hash inside");
  });
});
