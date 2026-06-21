import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import { initAppearance } from "./lib/appearance";
import "./styles.css";

// Apply the persisted theme/layout to <html> before React renders so the
// first paint is already in the chosen appearance (no flash).
initAppearance();

const root = document.getElementById("root");
if (root === null) throw new Error("missing #root element");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
