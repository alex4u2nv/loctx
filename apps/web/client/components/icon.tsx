/**
 * Centralised Font Awesome import. Tree-shakes the unused icons out at
 * build time; pages reference them by semantic name (`<Icon name="pause" />`)
 * so swapping the icon library later only touches this file.
 */

import {
  faArrowsRotate,
  faBan,
  faBolt,
  faCheckCircle,
  faCircleXmark,
  faCopy,
  faEraser,
  faMagnifyingGlass,
  faPause,
  faPlay,
  faPowerOff,
  faRotateRight,
  faTriangleExclamation,
  faWifi,
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";

const ICONS = {
  pause: faPause,
  play: faPlay,
  recrawl: faArrowsRotate,
  refresh: faRotateRight,
  purge: faEraser,
  reset: faBan,
  index: faBolt,
  stop: faPowerOff,
  search: faMagnifyingGlass,
  copy: faCopy,
  ok: faCheckCircle,
  warn: faTriangleExclamation,
  err: faCircleXmark,
  live: faWifi,
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({
  name,
  fixedWidth = true,
  className,
  title,
}: {
  name: IconName;
  fixedWidth?: boolean;
  className?: string;
  title?: string;
}) {
  return (
    <FontAwesomeIcon
      icon={ICONS[name]}
      fixedWidth={fixedWidth}
      {...(className !== undefined ? { className } : {})}
      {...(title !== undefined ? { title } : {})}
    />
  );
}
