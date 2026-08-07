/**
 * Tiny shared hook for "click button → call api → log result" flows
 * used by /admin and /projects. Tracks one in-flight op label and the
 * most recent message; calls reload() on success when supplied.
 */

import { useCallback, useState } from "react";

export interface RunOptions<T> {
  /**
   * Custom success banner derived from the result; return null to leave
   * the banner empty (e.g. when a details pane already shows the
   * outcome). Defaults to "`label`: ok".
   */
  readonly success?: (result: T) => string | null;
}

export interface OpRunner {
  readonly busy: string | null;
  readonly message: string | null;
  run<T>(label: string, fn: () => Promise<T>, opts?: RunOptions<T>): Promise<T | undefined>;
  /**
   * Write a failure into the same banner `run` uses, without taking the
   * global busy slot. For fire-and-forget operations that surface their
   * own progress (e.g. async rebuild) — the page shouldn't grey out
   * while we wait for a background job, but the user still needs to
   * see when the kickoff request itself fails.
   */
  surfaceError(label: string, err: unknown): void;
  /** Write an informational banner without claiming the busy slot. */
  notify(message: string): void;
  clearMessage(): void;
}

export function useOpRunner(onSuccess?: () => void): OpRunner {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const run = useCallback(
    async <T>(label: string, fn: () => Promise<T>, opts?: RunOptions<T>): Promise<T | undefined> => {
      setBusy(label);
      setMessage(null);
      try {
        const r = await fn();
        setMessage(opts?.success !== undefined ? opts.success(r) : `${label}: ok`);
        onSuccess?.();
        return r;
      } catch (e) {
        setMessage(`${label}: ${e instanceof Error ? e.message : String(e)}`);
        return undefined;
      } finally {
        setBusy(null);
      }
    },
    [onSuccess],
  );

  const surfaceError = useCallback((label: string, err: unknown) => {
    setMessage(`${label}: ${err instanceof Error ? err.message : String(err)}`);
  }, []);

  const notify = useCallback((msg: string) => setMessage(msg), []);

  const clearMessage = useCallback(() => setMessage(null), []);

  return { busy, message, run, surfaceError, notify, clearMessage };
}
