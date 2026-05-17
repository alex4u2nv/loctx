/**
 * Tiny form primitive for "labeled input(s) + a submit button" queries:
 * the /find-usages page, the scoped search panel on /projects/:id, and
 * the scoped find-usages panel on the same page (#255 entry 6).
 *
 * Renders the existing `.search-form` + `.field` + `.input` CSS so the
 * visual rhythm is unchanged — this is purely about pulling repeated
 * JSX out of three route files.
 *
 * Each field is a controlled name+label+input triple. The form
 * collects values by name on submit and hands them to the caller as a
 * `Record<string, string>`. Trimming + empty-handling stays with the
 * caller since different surfaces want different validation
 * semantics (find-usages requires the symbol but allows blank path;
 * scoped panels skip the path field entirely).
 */

import type { FormEvent } from "react";

export interface QueryFormField {
  readonly id: string;
  readonly name: string;
  readonly label: string;
  readonly placeholder?: string;
  /** Helpful text shown after the label when this field can be left blank. */
  readonly optional?: boolean;
  readonly autoFocus?: boolean;
  /** Initial value (e.g. from URL params on first render). Uncontrolled. */
  readonly defaultValue?: string;
}

export interface QueryFormProps {
  readonly fields: ReadonlyArray<QueryFormField>;
  readonly submitLabel: string;
  readonly busyLabel?: string;
  readonly busy: boolean;
  readonly onSubmit: (values: Record<string, string>) => void;
}

export function QueryForm({
  fields,
  submitLabel,
  busyLabel = "Searching…",
  busy,
  onSubmit,
}: QueryFormProps) {
  const handle = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const values: Record<string, string> = {};
    for (const f of fields) {
      values[f.name] = String(fd.get(f.name) ?? "").trim();
    }
    onSubmit(values);
  };
  return (
    <form className="search-form" onSubmit={handle}>
      {fields.map((f) => (
        <div className="field" key={f.id}>
          <label htmlFor={f.id}>
            {f.label}
            {f.optional === true ? <span className="dim"> (optional)</span> : null}
          </label>
          <input
            id={f.id}
            name={f.name}
            type="text"
            className="input"
            {...(f.placeholder !== undefined ? { placeholder: f.placeholder } : {})}
            {...(f.autoFocus === true ? { autoFocus: true } : {})}
            {...(f.defaultValue !== undefined ? { defaultValue: f.defaultValue } : {})}
          />
        </div>
      ))}
      <button type="submit" className="btn btn-primary field-submit" disabled={busy}>
        {busy ? busyLabel : submitLabel}
      </button>
    </form>
  );
}
