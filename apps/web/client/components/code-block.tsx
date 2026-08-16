/**
 * Inline code viewport with an IDE-style line-number gutter. Plain
 * monospace (syntax highlighting stays in the click-to-open SnippetModal,
 * which is heavier); the gutter + absolute line numbers give search results
 * the "code runner" feel without an async highlight per result.
 */

export function CodeBlock({
  snippet,
  startLine = 1,
  maxLines,
}: {
  snippet: string;
  /** Absolute first-line number for the gutter. */
  startLine?: number;
  /** Clip to this many lines (adds a truncation marker). */
  maxLines?: number;
}) {
  let lines = snippet.replace(/\n$/, "").split("\n");
  let clipped = false;
  if (maxLines !== undefined && lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    clipped = true;
  }
  return (
    <div className="code-block">
      {lines.map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: startLine + i IS the semantic identity of the row — its absolute line number in the source file
        <div className="code-line" key={`${startLine + i}`}>
          <span className="code-gutter" aria-hidden>
            {startLine + i}
          </span>
          <span className="code-content">{line === "" ? " " : line}</span>
        </div>
      ))}
      {clipped ? (
        <div className="code-line code-line-more">
          <span className="code-gutter" aria-hidden>
            ⋯
          </span>
          <span className="code-content dim">… click the path to view the full snippet</span>
        </div>
      ) : null}
    </div>
  );
}
