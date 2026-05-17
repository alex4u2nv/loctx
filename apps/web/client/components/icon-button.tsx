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
  readonly icon: IconName;
  readonly label: ReactNode;
  readonly disabled?: boolean;
  readonly title?: string;
  readonly animate?: boolean;
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
  const inner = (
    <>
      <Icon name={props.icon} {...(props.animate === true ? { animate: true } : {})} /> {props.label}
    </>
  );
  if (props.href !== undefined) {
    // Disabled link is rendered as an inert <span> styled like a
    // disabled button so router doesn't navigate when interaction
    // should be blocked.
    if (props.disabled === true) {
      return (
        <span
          className="btn"
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
        className="btn"
        {...(props.title !== undefined ? { title: props.title } : {})}
      >
        {inner}
      </Link>
    );
  }
  return (
    <button
      type="button"
      className="btn"
      onClick={props.onClick}
      disabled={props.disabled}
      {...(props.title !== undefined ? { title: props.title } : {})}
    >
      {inner}
    </button>
  );
}
