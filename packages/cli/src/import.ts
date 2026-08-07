/**
 * Split a markdown/text document into memory-sized chunks: one memory per
 * bullet line, one per plain paragraph. Headings are dropped (structure, not
 * facts); chunks under 10 chars are noise.
 */
export function splitIntoMemories(text: string): string[] {
  const out: string[] = [];
  for (const block of text.split(/\n\s*\n/)) {
    const lines = block
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !/^#{1,6}\s/.test(l));
    if (lines.length === 0) continue;
    if (lines.every((l) => /^[-*+]\s/.test(l))) {
      out.push(...lines.map((l) => l.replace(/^[-*+]\s+/, "")));
    } else {
      // ponytail: mixed text+bullet blocks become one memory; per-sentence
      // splitting if imported chunks prove too coarse for retrieval.
      out.push(lines.map((l) => l.replace(/^[-*+]\s+/, "")).join(" "));
    }
  }
  return out.filter((s) => s.length >= 10);
}
