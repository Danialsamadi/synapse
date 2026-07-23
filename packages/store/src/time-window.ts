/**
 * Maps relative time expressions in a retrieval query onto a [since, until)
 * ISO window. Covers the common phrases; anything unmatched returns {}.
 * ponytail: regex phrase table, not NLP — extend the table when a phrase matters.
 */
export function parseTimeWindow(query: string, now = new Date()): { since?: string; until?: string } {
  const q = query.toLowerCase();
  const day = 24 * 60 * 60 * 1000;
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const today = startOfDay(now);
  const win = (from: Date, to?: Date) => ({
    since: from.toISOString(),
    ...(to ? { until: to.toISOString() } : {}),
  });

  const ago = q.match(/(\d+)\s+(day|week|month)s?\s+ago/);
  if (ago) {
    const n = Number(ago[1]);
    const unit = ago[2] === "day" ? 1 : ago[2] === "week" ? 7 : 30;
    const from = new Date(today.getTime() - n * unit * day);
    return win(from, new Date(from.getTime() + unit * day));
  }
  const lastN = q.match(/(?:last|past)\s+(\d+)\s+(day|week|month)s?/);
  if (lastN) {
    const n = Number(lastN[1]);
    const unit = lastN[2] === "day" ? 1 : lastN[2] === "week" ? 7 : 30;
    return win(new Date(today.getTime() - n * unit * day));
  }
  if (/\byesterday\b|\blast night\b/.test(q)) return win(new Date(today.getTime() - day), today);
  if (/\btoday\b/.test(q)) return win(today);
  if (/\bthis week\b/.test(q)) {
    const dow = (today.getDay() + 6) % 7; // Monday start
    return win(new Date(today.getTime() - dow * day));
  }
  if (/\blast week\b/.test(q)) {
    const dow = (today.getDay() + 6) % 7;
    const thisMonday = new Date(today.getTime() - dow * day);
    return win(new Date(thisMonday.getTime() - 7 * day), thisMonday);
  }
  if (/\bthis month\b/.test(q)) return win(new Date(now.getFullYear(), now.getMonth(), 1));
  if (/\blast month\b/.test(q)) {
    return win(
      new Date(now.getFullYear(), now.getMonth() - 1, 1),
      new Date(now.getFullYear(), now.getMonth(), 1),
    );
  }
  if (/\bthis year\b/.test(q)) return win(new Date(now.getFullYear(), 0, 1));
  if (/\blast year\b/.test(q)) {
    return win(new Date(now.getFullYear() - 1, 0, 1), new Date(now.getFullYear(), 0, 1));
  }
  return {};
}
