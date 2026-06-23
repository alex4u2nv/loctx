/**
 * Centralised Font Awesome import. Tree-shakes the unused icons out at
 * build time; pages reference them by semantic name (`<Icon name="pause" />`)
 * so swapping the icon library later only touches this file.
 */

import {
  faBan,
  faBars,
  faBell,
  faBolt,
  faCheckCircle,
  faChevronDown,
  faCircleXmark,
  faCopy,
  faCube,
  faEllipsisVertical,
  faEraser,
  faFolderTree,
  faGaugeHigh,
  faGear,
  faHammer,
  faMagnifyingGlass,
  faMoon,
  faPause,
  faPlay,
  faPowerOff,
  faQuoteRight,
  faRotateRight,
  faScroll,
  faSitemap,
  faSliders,
  faStethoscope,
  faSun,
  faTriangleExclamation,
  faWifi,
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";

const ICONS = {
  pause: faPause,
  play: faPlay,
  rebuild: faHammer,
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
  bell: faBell,
  "chevron-down": faChevronDown,
  more: faEllipsisVertical,
  // Sidebar nav + theme toggle (TailAdmin shell)
  dashboard: faGaugeHigh,
  projects: faFolderTree,
  usages: faSitemap,
  literal: faQuoteRight,
  doctor: faStethoscope,
  models: faCube,
  config: faGear,
  logs: faScroll,
  admin: faSliders,
  sun: faSun,
  moon: faMoon,
  menu: faBars,
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({
  name,
  fixedWidth = true,
  className,
  title,
  animate,
}: {
  name: IconName;
  fixedWidth?: boolean;
  className?: string;
  title?: string;
  /**
   * When true, applies FontAwesome's `beat` animation — a periodic
   * pulse that signals "this is actively doing work" without the
   * disorientation of a continuously spinning icon. Used for the
   * rebuild hammer while a job is running or resuming.
   */
  animate?: boolean;
}) {
  return (
    <FontAwesomeIcon
      icon={ICONS[name]}
      fixedWidth={fixedWidth}
      {...(className !== undefined ? { className } : {})}
      {...(title !== undefined ? { title } : {})}
      {...(animate === true ? { beat: true } : {})}
    />
  );
}
