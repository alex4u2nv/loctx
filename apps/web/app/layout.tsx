import { LiveRefresh } from "@/components/live-refresh";
import type { Metadata } from "next";
import Link from "next/link";
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
            gap: 24,
          }}
        >
          <strong>loctx</strong>
          <nav style={{ display: "flex", gap: 16, fontSize: 14 }}>
            <Link href="/" style={{ color: "#9ba3c4", textDecoration: "none" }}>
              status
            </Link>
            <Link href="/projects" style={{ color: "#9ba3c4", textDecoration: "none" }}>
              projects
            </Link>
            <Link href="/search" style={{ color: "#9ba3c4", textDecoration: "none" }}>
              search
            </Link>
          </nav>
          <span
            style={{
              marginLeft: "auto",
              display: "flex",
              alignItems: "center",
              gap: 16,
              color: "#7a85b8",
              fontSize: 13,
            }}
          >
            <LiveRefresh />
            <span>
              mcp endpoint: <code style={{ color: "#9ba3c4" }}>/mcp</code>
            </span>
          </span>
        </header>
        <main style={{ padding: 24, maxWidth: 1100, margin: "0 auto" }}>{children}</main>
      </body>
    </html>
  );
}
