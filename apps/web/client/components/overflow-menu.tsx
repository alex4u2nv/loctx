/**
 * A compact "⋮" overflow menu for secondary row actions — keeps dense
 * tables (projects) scannable by collapsing a cluster of buttons into one
 * trigger. Not a modal: a lightweight dropdown (outside-click + Escape to
 * close, no portal), styled from tokens so it follows the active theme.
 */

import { useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "./icon";

export interface OverflowItem {
  readonly label: string;
  readonly icon?: IconName;
  readonly onSelect: () => void;
  readonly danger?: boolean;
  readonly disabled?: boolean;
}

export function OverflowMenu({
  items,
  disabled = false,
  title = "more actions",
}: {
  items: ReadonlyArray<OverflowItem>;
  disabled?: boolean;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

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

  if (items.length === 0) return null;

  return (
    <span className="overflow-menu" ref={ref}>
      <button
        type="button"
        className="overflow-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={title}
        title={title}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="more" />
      </button>
      {open ? (
        <div className="overflow-panel" role="menu">
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className={`overflow-item${item.danger === true ? " danger" : ""}`}
              disabled={item.disabled === true}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.icon !== undefined ? <Icon name={item.icon} /> : null}
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </span>
  );
}
