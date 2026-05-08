import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "loctx admin",
  description: "Local workspace indexer + MCP search admin UI.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
          margin: 0,
          background: "#0b1020",
          color: "#e6e8ef",
        }}
      >
        <header
          style={{
            padding: "16px 24px",
            borderBottom: "1px solid #1f2540",
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <strong>loctx</strong>
          <span style={{ color: "#7a85b8", fontSize: 14 }}>
            local indexer · mcp search · workspace admin
          </span>
        </header>
        <main style={{ padding: 24, maxWidth: 1100, margin: "0 auto" }}>{children}</main>
      </body>
    </html>
  );
}
