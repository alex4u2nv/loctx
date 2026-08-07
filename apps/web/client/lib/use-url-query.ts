/**
 * Shared query state machine for the submit→fetch→render surfaces
 * (2026-08-06 audit, WEB-2 + WEB-4). Two layers:
 *
 *   - `useQuery(run)` — the bare machine. One discriminated union
 *     replaces the `response`/`error`/`busy` triple every panel used to
 *     hand-roll. Previous data stays visible while a re-submit is in
 *     flight (matching the old pages, where `response` wasn't cleared
 *     until the new result landed).
 *
 *   - `useUrlQuery(codec, run)` — the machine plus URL mirroring for the
 *     deep-linkable pages (/search, /find-usages, /find-literal).
 *     `submit` writes the canonical param form via the codec; an effect
 *     auto-fires when a URL arrives from outside (bookmark, back/forward,
 *     symbol chip from another page). A `lastFired` key — the encoded
 *     canonical params — dedupes the effect so a submit that just
 *     mirrored itself into the URL doesn't fetch twice (the three old
 *     copies had drifted on exactly this loop-avoidance mechanism).
 *
 * The scoped panels on /projects/:id use `useQuery` directly: their
 * queries were never URL-mirrored and putting three panels' state into
 * one search string would change navigation behavior.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { UrlQueryCodec } from "./query-codecs";

type QueryState<Res> =
  | { readonly phase: "idle" }
  | { readonly phase: "busy"; readonly prev: Res | null }
  | { readonly phase: "done"; readonly data: Res }
  | { readonly phase: "error"; readonly message: string };

export interface QueryHandle<Req, Res> {
  /** Last successful payload; during a re-submit, the previous one. */
  readonly data: Res | null;
  readonly error: string | null;
  readonly busy: boolean;
  /** Fire the query. Always fetches — callers guard empty input. */
  readonly submit: (req: Req) => void;
}

export interface UrlQueryHandle<Req, Res> extends Omit<QueryHandle<Req, Res>, "submit"> {
  /**
   * Mirror the request into the URL, then fetch. An "empty" request
   * (one the codec decodes to null) clears both params and results.
   */
  readonly submit: (req: Req) => void;
  /** Current URL params — for form defaultValues / remount keys. */
  readonly params: URLSearchParams;
}

/** Core machine shared by both hooks. `run` is kept in a ref so callers
 * can pass inline closures without re-arming effects. */
function useQueryMachine<Req, Res>(run: (req: Req) => Promise<Res>): {
  readonly state: QueryState<Res>;
  readonly fire: (req: Req) => void;
  readonly clear: () => void;
} {
  const [state, setState] = useState<QueryState<Res>>({ phase: "idle" });
  const runRef = useRef(run);
  runRef.current = run;
  // Monotonic sequence so a slow earlier request can't clobber the
  // result of a later one.
  const seq = useRef(0);

  const fire = useCallback((req: Req): void => {
    const id = ++seq.current;
    setState((s) => ({
      phase: "busy",
      prev: s.phase === "done" ? s.data : s.phase === "busy" ? s.prev : null,
    }));
    void runRef
      .current(req)
      .then((data) => {
        if (seq.current === id) setState({ phase: "done", data });
      })
      .catch((e: unknown) => {
        if (seq.current === id)
          setState({ phase: "error", message: e instanceof Error ? e.message : String(e) });
      });
  }, []);

  const clear = useCallback((): void => {
    seq.current += 1; // invalidate any in-flight request
    setState({ phase: "idle" });
  }, []);

  return { state, fire, clear };
}

function toHandle<Res>(state: QueryState<Res>): {
  data: Res | null;
  error: string | null;
  busy: boolean;
} {
  return {
    data: state.phase === "done" ? state.data : state.phase === "busy" ? state.prev : null,
    error: state.phase === "error" ? state.message : null,
    busy: state.phase === "busy",
  };
}

export function useQuery<Req, Res>(run: (req: Req) => Promise<Res>): QueryHandle<Req, Res> {
  const { state, fire } = useQueryMachine(run);
  return { ...toHandle(state), submit: fire };
}

export function useUrlQuery<Req, Res>(
  codec: UrlQueryCodec<Req>,
  run: (req: Req) => Promise<Res>,
): UrlQueryHandle<Req, Res> {
  const [params, setParams] = useSearchParams();
  const { state, fire, clear } = useQueryMachine(run);
  const codecRef = useRef(codec);
  codecRef.current = codec;
  // Canonical param string of the last request we fired (or cleared to).
  // Written by submit *before* setParams so the auto-fire effect below
  // doesn't double-fetch the submit it's reacting to.
  const lastFired = useRef<string>("");

  const submit = useCallback(
    (req: Req): void => {
      const next = codecRef.current.encode(req);
      const key = next.toString();
      lastFired.current = key;
      setParams((prev) => (prev.toString() === key ? prev : next));
      if (codecRef.current.decode(next) === null) {
        clear();
        return;
      }
      fire(req);
    },
    [setParams, fire, clear],
  );

  // Auto-fire when a URL deep-link arrives with a fireable query
  // (bookmark, back/forward, a link from another page). A URL that goes
  // back to "no query" keeps showing the last results, matching the old
  // pages' behavior.
  useEffect(() => {
    const req = codecRef.current.decode(params);
    if (req === null) return;
    const key = codecRef.current.encode(req).toString();
    if (lastFired.current === key) return;
    lastFired.current = key;
    fire(req);
  }, [params, fire]);

  return { ...toHandle(state), submit, params };
}
