/**
 * Theme switcher in the top-right command bar. A lightweight dropdown (no
 * portal — it's a menu, not a modal) listing the themes, each with a colour
 * swatch so you can preview-pick. Selection applies instantly and persists.
 */

import { useEffect, useRef, useState } from "react";
import { applyTheme, getTheme, THEMES } from "../lib/appearance";
import { Icon } from "./icon";

export function AppearanceMenu() {
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState(getTheme);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      if (ref.current !== null && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pickTheme = (id: string): void => {
    setTheme(id);
    applyTheme(id);
  };
  const label = THEMES.find((t) => t.id === theme)?.label ?? "Theme";

  return (
    <div className="appearance" ref={ref}>
      <button
        type="button"
        className="nav-mcp appearance-trigger"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Theme"
      >
        <span className={`swatch swatch-${theme}`} aria-hidden /> {label}{" "}
        <Icon name="chevron-down" />
      </button>
      {open ? (
        <div className="appearance-panel" role="menu">
          <p className="appearance-group">Theme</p>
          {THEMES.map((t) => (
            <button
              key={t.id}
              type="button"
              role="menuitemradio"
              aria-checked={t.id === theme}
              className={`appearance-item${t.id === theme ? " active" : ""}`}
              onClick={() => pickTheme(t.id)}
            >
              <span className={`swatch swatch-${t.id}`} aria-hidden />
              <span className="appearance-text">
                <span className="appearance-label">{t.label}</span>
                <span className="appearance-hint">{t.hint}</span>
              </span>
              {t.id === theme ? <Icon name="ok" /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
