/**
 * Tiny form primitive for "labeled input(s) + a submit button" queries:
 * /search, /find-usages, /find-literal, and the scoped panels on
 * /projects/:id (#255 entry 6; 2026-08-06 audit WEB-4).
 *
 * Renders the existing `.search-form` + `.field` + `.input` CSS so the
 * visual rhythm is unchanged — this is purely about pulling repeated
 * JSX out of the route files.
 *
 * Each field is a name+label+input triple with a `type` union
 * (text / checkbox / number). The form collects values by name on
 * submit and hands them to the caller as a `Record<string, string>`
 * (checkboxes report `"on"` when checked, `""` otherwise, matching
 * FormData). Trimming + empty-handling stays with the caller since
 * different surfaces want different validation semantics.
 */

import type { FormEvent } from "react";

export type QueryFieldType = "text" | "checkbox" | "number";

export interface QueryFormField {
  readonly id: string;
  readonly name: string;
  readonly label: string;
  /** Input type; defaults to "text". */
  readonly type?: QueryFieldType;
  readonly placeholder?: string;
  /** Helpful text shown after the label when this field can be left blank. */
  readonly optional?: boolean;
  readonly autoFocus?: boolean;
  /** Initial value (e.g. from URL params on first render). Uncontrolled. */
  readonly defaultValue?: string;
  /** Checkbox only: initial checked state. Uncontrolled. */
  readonly defaultChecked?: boolean;
  /** id of a `<datalist>` the page renders (suggestions). */
  readonly datalist?: string;
  /** Number only. */
  readonly min?: number;
  readonly max?: number;
  /** Inline width override (e.g. "5rem" for the limit field). */
  readonly width?: string;
  /** Tooltip on the label (e.g. the coverage explainer). */
  readonly title?: string;
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
      {fields.map((f) =>
        f.type === "checkbox" ? (
          <div className="field" key={f.id}>
            <label htmlFor={f.id} {...(f.title !== undefined ? { title: f.title } : {})}>
              <input
                id={f.id}
                type="checkbox"
                name={f.name}
                {...(f.defaultChecked === true ? { defaultChecked: true } : {})}
                style={{ marginRight: "0.4rem" }}
              />
              {f.label}
            </label>
          </div>
        ) : (
          <div className="field" key={f.id}>
            <label htmlFor={f.id} {...(f.title !== undefined ? { title: f.title } : {})}>
              {f.label}
              {f.optional === true ? <span className="dim"> (optional)</span> : null}
            </label>
            <input
              id={f.id}
              name={f.name}
              type={f.type ?? "text"}
              className="input"
              {...(f.placeholder !== undefined ? { placeholder: f.placeholder } : {})}
              {...(f.autoFocus === true ? { autoFocus: true } : {})}
              {...(f.defaultValue !== undefined ? { defaultValue: f.defaultValue } : {})}
              {...(f.datalist !== undefined ? { list: f.datalist } : {})}
              {...(f.min !== undefined ? { min: f.min } : {})}
              {...(f.max !== undefined ? { max: f.max } : {})}
              {...(f.width !== undefined ? { style: { width: f.width } } : {})}
            />
          </div>
        ),
      )}
      <button type="submit" className="btn btn-primary field-submit" disabled={busy}>
        {busy ? busyLabel : submitLabel}
      </button>
    </form>
  );
}
