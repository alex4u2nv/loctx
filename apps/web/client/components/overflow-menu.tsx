/**
 * A compact "⋮" overflow menu for secondary row actions — keeps dense
 * tables (projects) scannable by collapsing a cluster of buttons into one
 * trigger.
 *
 * The panel is portaled to <body> and positioned `fixed` from the trigger's
 * rect: table rows live inside a `.card` with `overflow: hidden` (so flush
 * tables clip to the rounded corners), which would otherwise truncate an
 * absolutely-positioned dropdown. This is a positioned menu, not a modal —
 * it closes on outside-click / Escape / scroll.
 */

import { type CSSProperties, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "./icon";

export interface OverflowItem {
  readonly label: string;
  readonly icon?: IconName;
  readonly onSelect: () => void;
  readonly danger?: boolean;
  readonly disabled?: boolean;
}

// Approximate panel height used only to decide flip direction near the
// viewport's bottom edge; exact height isn't needed.
const FLIP_MARGIN = 240;

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
  const [pos, setPos] = useState<CSSProperties | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) === true) return;
      if (panelRef.current?.contains(t) === true) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    // Position is captured once from the trigger rect; a scroll/resize would
    // leave it detached, so just close.
    const onShift = (): void => setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onShift, true);
    window.addEventListener("resize", onShift);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onShift, true);
      window.removeEventListener("resize", onShift);
    };
  }, [open]);

  if (items.length === 0) return null;

  const toggle = (): void => {
    if (open) {
      setOpen(false);
      return;
    }
    const r = triggerRef.current?.getBoundingClientRect();
    if (r !== undefined) {
      const right = Math.max(8, window.innerWidth - r.right);
      const flipUp = r.bottom > window.innerHeight - FLIP_MARGIN;
      setPos(
        flipUp
          ? { position: "fixed", right, bottom: window.innerHeight - r.top + 4, top: "auto" }
          : { position: "fixed", right, top: r.bottom + 4, bottom: "auto" },
      );
    }
    setOpen(true);
  };

  return (
    <span className="overflow-menu">
      <button
        ref={triggerRef}
        type="button"
        className="overflow-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={title}
        title={title}
        disabled={disabled}
        onClick={toggle}
      >
        <Icon name="more" />
      </button>
      {open && pos !== null
        ? createPortal(
            <div ref={panelRef} className="overflow-panel" role="menu" style={pos}>
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
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}
