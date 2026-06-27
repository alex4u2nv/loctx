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
        .forEach((e, i) => {
          const el = e.target as HTMLElement;
          el.style.setProperty("--reveal-delay", `${Math.min(i, STAGGER_CAP) * STAGGER_MS}ms`);
          el.classList.add("reveal-visible");
          io.unobserve(el);
        });
    },
    // Trigger a touch before the element is fully in view so it's settled by
    // the time it reaches reading position.
    { rootMargin: "0px 0px -8% 0px", threshold: 0.06 },
  );

  const tag = (el: HTMLElement): void => {
    if (el.dataset["reveal"] !== undefined) return;
    el.dataset["reveal"] = "";
    io.observe(el);
  };
  const scan = (node: ParentNode): void => {
    for (const el of node.querySelectorAll<HTMLElement>(REVEAL_SELECTOR)) tag(el);
  };

  // Tag whatever's already mounted (the eager dashboard route).
  scan(root);

  // Pick up lazily-mounted route content + any dynamically-added cards.
  // MutationObserver callbacks run as microtasks before the next paint, so
  // the hidden state lands before the node is first painted — no flash.
  const mo = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.matches(REVEAL_SELECTOR)) tag(node);
        scan(node);
      }
    }
  });
  mo.observe(root, { childList: true, subtree: true });

  return () => {
    mo.disconnect();
    io.disconnect();
  };
}
