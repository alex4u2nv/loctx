/**
 * URL-param ↔ request codecs for the three URL-driven query pages
 * (/search, /find-usages, /find-literal). Pulled out of the routes so
 * `useUrlQuery` can dedupe auto-fires on a canonical key and so the
 * round-trip behavior is unit-testable without a DOM (the client has no
 * jsdom test setup — see tests/unit/query-codecs.test.ts).
 *
 * Contract:
 *   - `decode(params)` parses the page's URL params into a request, or
 *     returns `null` when the URL carries no fireable query (empty
 *     q/pattern/symbol). Defaults (limit=10, empty path/language) match
 *     what each page historically applied.
 *   - `encode(req)` mirrors a request back into URLSearchParams in the
 *     page's canonical form — default values are omitted, so
 *     `encode(decode(p))` is the canonical spelling of `p`.
 *
 * Each page's exact param names are load-bearing: they're deep-linked
 * from /search symbol chips, bookmarks, and the e2e suite.
 */

export interface SearchQuery {
  readonly q: string;
  readonly path: string;
  readonly limit: number;
  readonly language: string;
  readonly coverage: boolean;
}

export interface FindLiteralQuery {
  readonly pattern: string;
  readonly path: string;
}

export interface FindUsagesQuery {
  readonly symbol: string;
  readonly path: string;
}

export interface UrlQueryCodec<Req> {
  /** Parse URL params into a request; `null` when there's nothing to fire. */
  decode(params: URLSearchParams): Req | null;
  /** Mirror a request into URL params (canonical form, defaults omitted). */
  encode(req: Req): URLSearchParams;
}

export const SEARCH_DEFAULT_LIMIT = 10;

export const searchCodec: UrlQueryCodec<SearchQuery> = {
  decode(params) {
    const q = params.get("q")?.trim() ?? "";
    if (q === "") return null;
    return {
      q,
      path: params.get("path") ?? "",
      limit:
        Number.parseInt(params.get("limit") ?? String(SEARCH_DEFAULT_LIMIT), 10) ||
        SEARCH_DEFAULT_LIMIT,
      language: params.get("language") ?? "",
      coverage: params.get("coverage") === "1",
    };
  },
  encode(req) {
    const next = new URLSearchParams();
    if (req.q) next.set("q", req.q);
    if (req.path) next.set("path", req.path);
    if (req.limit !== SEARCH_DEFAULT_LIMIT) next.set("limit", String(req.limit));
    if (req.language) next.set("language", req.language);
    if (req.coverage) next.set("coverage", "1");
    return next;
  },
};

export const findLiteralCodec: UrlQueryCodec<FindLiteralQuery> = {
  decode(params) {
    const pattern = params.get("pattern")?.trim() ?? "";
    if (pattern === "") return null;
    return { pattern, path: params.get("path") ?? "" };
  },
  encode(req) {
    const next = new URLSearchParams();
    if (req.pattern) next.set("pattern", req.pattern);
    if (req.path) next.set("path", req.path);
    return next;
  },
};

export const findUsagesCodec: UrlQueryCodec<FindUsagesQuery> = {
  decode(params) {
    const symbol = params.get("symbol") ?? "";
    if (symbol === "") return null;
    return { symbol, path: params.get("path") ?? "" };
  },
  encode(req) {
    const next = new URLSearchParams();
    if (req.symbol) next.set("symbol", req.symbol);
    if (req.path) next.set("path", req.path);
    return next;
  },
};
