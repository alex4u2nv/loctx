/**
 * Theme + layout switcher in the top-right nav. A lightweight dropdown
 * (no portal — it's a menu, not a modal) listing the available themes and
 * layouts, each with a colour swatch so you can preview-pick. Selections
 * apply instantly and persist via lib/appearance.
 */

import { useEffect, useRef, useState } from "react";
import {
  type AppearanceOption,
  applyLayout,
  applyTheme,
  getLayout,
  getTheme,
  LAYOUTS,
  THEMES,
} from "../lib/appearance";
import { Icon } from "./icon";

export function AppearanceMenu() {
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState(getTheme);
  const [layout, setLayout] = useState(getLayout);
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
  const pickLayout = (id: string): void => {
    setLayout(id);
    applyLayout(id);
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
        title="Theme & layout"
      >
        <span className={`swatch swatch-${theme}`} aria-hidden /> {label} <Icon name="chevron-down" />
      </button>
      {open ? (
        <div className="appearance-panel" role="menu">
          <p className="appearance-group">Theme</p>
          {THEMES.map((t) => (
            <OptionRow
              key={t.id}
              option={t}
              active={t.id === theme}
              onPick={() => pickTheme(t.id)}
              swatchClass={`swatch-${t.id}`}
            />
          ))}
          <p className="appearance-group">Layout</p>
          {LAYOUTS.map((l) => (
            <OptionRow
              key={l.id}
              option={l}
              active={l.id === layout}
              onPick={() => pickLayout(l.id)}
              swatchClass={`swatch-layout-${l.id}`}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function OptionRow({
  option,
  active,
  onPick,
  swatchClass,
}: {
  option: AppearanceOption;
  active: boolean;
  onPick: () => void;
  swatchClass: string;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={active}
      className={`appearance-item${active ? " active" : ""}`}
      onClick={onPick}
    >
      <span className={`swatch ${swatchClass}`} aria-hidden />
      <span className="appearance-text">
        <span className="appearance-label">{option.label}</span>
        <span className="appearance-hint">{option.hint}</span>
      </span>
      {active ? <Icon name="ok" /> : null}
    </button>
  );
}
