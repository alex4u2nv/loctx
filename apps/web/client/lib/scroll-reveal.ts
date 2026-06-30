/**
 * Apple-style scroll reveal. Structural section blocks (`.card`, plus any
 * element opting in with `data-reveal-target`) are tagged with `data-reveal`
 * — which CSS renders hidden + offset — then flipped to `.reveal-visible` as
 * they scroll into view, with a small per-batch stagger so above-the-fold
 * sections cascade in rather than popping at once.
 *
 * Driven by IntersectionObserver (cross-browser, unlike CSS scroll
 * timelines which Safari still lacks) plus a MutationObserver so lazily
 * code-split route content is picked up automatically — no per-page wiring.
 * One-shot: a revealed element is unobserved and never re-hides on
 * scroll-up (matches apple.com, and avoids re-animation jank).
 *
 * Degrades safely: the hidden state only applies to the JS-added
 * `data-reveal` attribute, so if IntersectionObserver is missing (or JS
 * fails) nothing is tagged and all content renders normally.
 */

const REVEAL_SELECTOR = ".card, [data-reveal-target]";
/** Per-element delay within a single intersection batch (the cascade step). */
const STAGGER_MS = 70;
/** Cap so a tall above-the-fold batch doesn't trail in for too long. */
const STAGGER_CAP = 6;

export function initScrollReveal(root: HTMLElement): () => void {
  if (typeof IntersectionObserver === "undefined") return () => undefined;

  const io = new IntersectionObserver(
    (entries) => {
      // Stagger within each callback batch (top-to-bottom) so the initial
      // above-the-fold set cascades; elements scrolled in later usually
      // arrive one-at-a-time and get ~zero delay.
      entries
        .filter((e) => e.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
        .forEach((e, i) => reveal(e.target as HTMLElement, i));
    },
    // Trigger a touch before the element is fully in view so it's settled by
    // the time it reaches reading position.
    { rootMargin: "0px 0px -8% 0px", threshold: 0.06 },
  );

  // Idempotent — both the observer and the failsafe sweep call this, and a
  // revealed element must never be re-hidden or double-staggered.
  function reveal(el: HTMLElement, index = 0): void {
    if (el.classList.contains("reveal-visible")) return;
    el.style.setProperty("--reveal-delay", `${Math.min(index, STAGGER_CAP) * STAGGER_MS}ms`);
    el.classList.add("reveal-visible");
    io.unobserve(el);
  }

  const tag = (el: HTMLElement): void => {
    if (el.dataset["reveal"] !== undefined) return;
    el.dataset["reveal"] = "";
    io.observe(el);
  };
  const scan = (node: ParentNode): void => {
    for (const el of node.querySelectorAll<HTMLElement>(REVEAL_SELECTOR)) tag(el);
  };

  // Failsafe (fixes #438 blank-page-on-navigate): IntersectionObserver's
  // first callback reports `isIntersecting:false` for an element measured at
  // zero size — common while a lazily code-split route is still mounting. On
  // a page that fits the viewport there's then no scroll to re-trigger the
  // observer, so the card would stay `opacity:0` forever (a blank page until
  // reload). After the browser has laid the new nodes out, force-reveal
  // anything already in the viewport that the observer hasn't caught;
  // below-the-fold elements stay hidden for the scroll cascade.
  let raf1 = 0;
  let raf2 = 0;
  const flushVisible = (): void => {
    const vh = window.innerHeight || document.documentElement.clientHeight;
    let shown = 0;
    for (const el of root.querySelectorAll<HTMLElement>("[data-reveal]:not(.reveal-visible)")) {
      const r = el.getBoundingClientRect();
      // Not laid out yet (zero-area): leave it for IO / a later sweep.
      if (r.width === 0 && r.height === 0) continue;
      if (r.top < vh && r.bottom > 0) reveal(el, shown++);
    }
  };
  const scheduleFlush = (): void => {
    // Double rAF so getBoundingClientRect reflects real geometry (post-layout,
    // post-paint) rather than the zero rect a freshly-mounted node reports.
    cancelAnimationFrame(raf1);
    cancelAnimationFrame(raf2);
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(flushVisible);
    });
  };

  // Tag whatever's already mounted (the eager dashboard route), then sweep.
  scan(root);
  scheduleFlush();

  // Pick up lazily-mounted route content + any dynamically-added cards, and
  // re-run the failsafe sweep after each batch so every navigation's
  // above-the-fold content is guaranteed to appear.
  const mo = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.matches(REVEAL_SELECTOR)) tag(node);
        scan(node);
      }
    }
    scheduleFlush();
  });
  mo.observe(root, { childList: true, subtree: true });

  return () => {
    cancelAnimationFrame(raf1);
    cancelAnimationFrame(raf2);
    mo.disconnect();
    io.disconnect();
  };
}
