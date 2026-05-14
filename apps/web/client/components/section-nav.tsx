import { useEffect, useState } from "react";

export interface NavSection {
  readonly id: string;
  readonly label: string;
}

export function SectionNav({ sections }: { sections: ReadonlyArray<NavSection> }) {
  const [activeId, setActiveId] = useState<string | null>(sections[0]?.id ?? null);

  useEffect(() => {
    if (sections.length === 0) return undefined;
    const visible = new Map<string, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visible.set(e.target.id, e.intersectionRatio);
          else visible.delete(e.target.id);
        }
        // Pick the section with the highest visible ratio; on ties, the one
        // declared earliest in `sections` (so the active dot doesn't jitter).
        let best: string | null = null;
        let bestRatio = 0;
        for (const s of sections) {
          const r = visible.get(s.id) ?? 0;
          if (r > bestRatio) {
            best = s.id;
            bestRatio = r;
          }
        }
        if (best !== null) setActiveId(best);
      },
      { rootMargin: "-20% 0px -60% 0px", threshold: [0, 0.25, 0.5, 0.75, 1] },
    );
    for (const s of sections) {
      const el = document.getElementById(s.id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [sections]);

  if (sections.length < 2) return null;

  return (
    <nav className="section-nav" aria-label="Page sections">
      {sections.map((s) => (
        <a
          key={s.id}
          href={`#${s.id}`}
          className={`section-nav-item ${activeId === s.id ? "active" : ""}`}
          title={s.label}
          onClick={(e) => {
            const el = document.getElementById(s.id);
            if (el) {
              e.preventDefault();
              el.scrollIntoView({ behavior: "smooth", block: "start" });
              history.replaceState(null, "", `#${s.id}`);
              setActiveId(s.id);
            }
          }}
        >
          <span className="section-nav-label">{s.label}</span>
        </a>
      ))}
    </nav>
  );
}
