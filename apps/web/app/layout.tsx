import { LiveRefresh } from "@/components/live-refresh";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "loctx admin",
  description: "Local workspace indexer + MCP search admin UI.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="nav">
          <span className="nav-brand">loctx</span>
          <nav className="nav-links">
            <Link href="/">status</Link>
            <Link href="/projects">projects</Link>
            <Link href="/search">search</Link>
          </nav>
          <span className="nav-meta">
            <LiveRefresh />
            <span>
              mcp <code>/mcp</code>
            </span>
          </span>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
