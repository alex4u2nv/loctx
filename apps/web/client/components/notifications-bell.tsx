/**
 * Top-nav bell that lists operator notifications in a modal.
 *
 * Source of truth is the `useNotifications` hook, which polls
 * /api/status and derives entries (currently: in-flight reconcile).
 * Adding new notification sources only means extending the hook —
 * this component stays simple.
 */

import { useState } from "react";
import { NavLink } from "react-router-dom";
import { type Notification, useNotifications } from "../lib/use-notifications";
import { Icon } from "./icon";
import { Modal } from "./modal";

export function NotificationsBell() {
  const { notifications } = useNotifications();
  const [open, setOpen] = useState(false);
  const count = notifications.length;

  return (
    <>
      <button
        type="button"
        className="nav-bell"
        onClick={() => setOpen(true)}
        title={count === 0 ? "Notifications (none)" : `${count} notification${count === 1 ? "" : "s"}`}
        aria-label={count === 0 ? "Notifications, no new" : `${count} notifications`}
      >
        <Icon name="bell" />
        {count > 0 ? <span className="nav-bell-count">{count}</span> : null}
      </button>
      {open ? (
        <NotificationsModal notifications={notifications} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}

function NotificationsModal({
  notifications,
  onClose,
}: {
  notifications: ReadonlyArray<Notification>;
  onClose: () => void;
}) {
  return (
    <Modal title="Notifications" titleId="notifications-title" onClose={onClose} maxWidth="640px">
      {notifications.length === 0 ? (
        <p className="modal-body" style={{ color: "var(--muted)" }}>
          No active notifications. The bell will surface reconcile passes, stuck rebuild flags,
          and watcher failures as they happen.
        </p>
      ) : (
        <ul className="notification-list">
          {notifications.map((n) => (
            <li key={n.id} className={`notification notification-${n.kind}`}>
              <div className="notification-title">{n.title}</div>
              <div className="notification-message">{n.message}</div>
              {n.href !== undefined ? (
                <NavLink className="notification-action" to={n.href} onClick={onClose}>
                  {n.actionLabel ?? "Open"} →
                </NavLink>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
