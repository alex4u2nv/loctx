/**
 * Icon-plus-label button. Lives at the shared layer because the same
 * affordance shows up on every route (#255 entry 4):
 *
 *   - /projects     — pause/resume/rebuild/purge/deactivate/inspect
 *   - /admin        — index/refresh/reset/stop
 *   - /models       — use/download
 *   - …
 *
 * The button form and the router-link form share styling but differ
 * in semantics (the link form should be navigable). Pass `href` to
 * render a `<Link>`; otherwise the button form fires `onClick`.
 *
 * Animation is driven by the underlying `<Icon animate>` prop (a thin
 * mapping to FontAwesome's `beat`), used by the rebuild hammer while
 * a rebuild is in flight.
 */

import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Icon, type IconName } from "./icon";

interface CommonProps {
  /**
   * Optional so icon-less `.btn` actions (e.g. /models use/download)
   * share the same primitive without gaining a glyph.
   */
  readonly icon?: IconName;
  readonly label: ReactNode;
  readonly disabled?: boolean;
  readonly title?: string;
  readonly animate?: boolean;
  /** Extra classes merged after `btn` (e.g. "btn-primary", "btn-small"). */
  readonly className?: string;
}

interface ButtonProps extends CommonProps {
  readonly onClick: () => void;
  readonly href?: undefined;
}

interface LinkProps extends CommonProps {
  readonly href: string;
  readonly onClick?: () => void;
}

export type IconButtonProps = ButtonProps | LinkProps;

export function IconButton(props: IconButtonProps) {
  const cls = props.className !== undefined ? `btn ${props.className}` : "btn";
  const inner = (
    <>
      {props.icon !== undefined ? (
        <>
          <Icon name={props.icon} {...(props.animate === true ? { animate: true } : {})} />{" "}
        </>
      ) : null}
      {props.label}
    </>
  );
  if (props.href !== undefined) {
    // Disabled link is rendered as an inert <span> styled like a
    // disabled button so router doesn't navigate when interaction
    // should be blocked.
    if (props.disabled === true) {
      return (
        <span
          className={cls}
          aria-disabled="true"
          {...(props.title !== undefined ? { title: props.title } : {})}
        >
          {inner}
        </span>
      );
    }
    return (
      <Link
        to={props.href}
        className={cls}
        {...(props.title !== undefined ? { title: props.title } : {})}
      >
        {inner}
      </Link>
    );
  }
  return (
    <button
      type="button"
      className={cls}
      onClick={props.onClick}
      disabled={props.disabled}
      {...(props.title !== undefined ? { title: props.title } : {})}
    >
      {inner}
    </button>
  );
}
