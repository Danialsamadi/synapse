/**
 * Render the LongMemEval round history into a single self-contained HTML page
 * (no build step, no CDN, inline SVG, tokens for colors — same rules as the
 * inspector). Data is inlined at generation time.
 *
 * Usage: node scripts/bench-page.mjs [outPath]
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const histPath = join(homedir(), ".synapse", "bench", "rounds", "history.json");
const out = process.argv[2] ?? join(homedir(), ".synapse", "bench", "progress.html");
const history = existsSync(histPath) ? JSON.parse(readFileSync(histPath, "utf8")) : [];

// The bar comes from packages/evals/data/baselines.json — published numbers for
// competing memory systems, with their caveats. Only `comparable: true` entries
// set a target: recall@k and oracle-split numbers measure something else.
const BASELINES = JSON.parse(
  readFileSync(new URL("../packages/evals/data/baselines.json", import.meta.url), "utf8"),
);
const CATS = BASELINES.categories;
const RIVALS = BASELINES.providers.filter((p) => p.comparable && p.overall !== null);
const best = (cat) =>
  RIVALS.reduce(
    (b, p) => (p.byCategory?.[cat] != null && p.byCategory[cat] > (b.score ?? -1) ? { score: p.byCategory[cat], who: p.name } : b),
    { score: null, who: null },
  );
// ZEP/FULL_CTX keep their names as the two reference lines on each chart: the
// bar (best published) and the no-memory floor.
const ZEP = Object.fromEntries(CATS.map((c) => [c, best(c).score ?? undefined]));
const HOLDER = Object.fromEntries(CATS.map((c) => [c, best(c).who]));
const ZEP_OVERALL = RIVALS.reduce((b, p) => Math.max(b, p.overall), 0);
// The named rivals get their own columns and reference line. "best published"
// is a harsher bar than either of them, so showing only it hides the fact that
// a category can beat Zep and Mem0 while still trailing the field leader.
const named = (name) => BASELINES.providers.find((p) => p.name === name);
const ZEP_REAL = named("Zep");
const MEM0 = named("Mem0");
const fullCtx = BASELINES.providers.find((p) => p.name === "full-context gpt-4o");
const FULL_CTX = Object.fromEntries(CATS.map((c) => [c, fullCtx.byCategory[c] ?? undefined]));
const FULL_CTX_OVERALL = fullCtx.overall;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const pct = (n) => (n * 100).toFixed(1) + "%";

// Wilson 95% interval — with n≈10–45 per category, a raw delta is not a result.
function wilson(correct, total) {
  if (!total) return [0, 0];
  const z = 1.96;
  const p = correct / total;
  const d = 1 + (z * z) / total;
  const c = p + (z * z) / (2 * total);
  const s = z * Math.sqrt(p * (1 - p) / total + (z * z) / (4 * total * total));
  return [Math.max(0, (c - s) / d), Math.min(1, (c + s) / d)];
}

const dev = history.filter((r) => r.split === "dev");
const holdout = history.filter((r) => r.split === "holdout");

function chart(cat) {
  const w = 260, h = 120, pad = 24;
  const pts = dev.map((r) => r.byType[cat]?.accuracy ?? null);
  const n = Math.max(pts.length, 2);
  const x = (i) => pad + (i * (w - pad * 2)) / (n - 1);
  const y = (v) => h - pad - v * (h - pad * 2);
  const line = pts
    .map((v, i) => (v === null ? null : `${x(i)},${y(v)}`))
    .filter(Boolean)
    .join(" ");
  return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(cat)} accuracy over rounds">
    ${ZEP[cat] === undefined ? "" : `<line x1="${pad}" y1="${y(ZEP[cat])}" x2="${w - pad}" y2="${y(ZEP[cat])}" class="bar-zep"/>`}
    ${FULL_CTX[cat] === undefined ? "" : `<line x1="${pad}" y1="${y(FULL_CTX[cat])}" x2="${w - pad}" y2="${y(FULL_CTX[cat])}" class="bar-ctx"/>`}
    ${line ? `<polyline points="${line}" class="line"/>` : ""}
    ${pts.map((v, i) => (v === null ? "" : `<circle cx="${x(i)}" cy="${y(v)}" r="3" class="dot"/>`)).join("")}
    <text x="${pad}" y="${h - 6}" class="ax">round 1</text>
    <text x="${w - pad}" y="${h - 6}" text-anchor="end" class="ax">${dev.length || 1}</text>
  </svg>`;
}

const rival = (p, c) => p?.byCategory?.[c];
const fmt = (v) => (v == null ? "n/a" : pct(v));
// Green only when we are ahead of that specific rival — a category can beat Zep
// and lose to Mem0, and the single "bar" column cannot show that.
const beat = (acc, r) => (acc === null || r == null ? "muted" : acc > r ? "win" : "loss");

const latest = dev[dev.length - 1];
const rows = CATS.map((cat) => {
  const v = latest?.byType[cat];
  const acc = v ? v.accuracy : null;
  const d = acc === null || ZEP[cat] === undefined ? null : acc - ZEP[cat];
  const [lo, hi] = v ? wilson(v.correct, v.total) : [0, 0];
  // "Beating" only counts when the interval clears the bar — n is small.
  const cls = d === null ? "" : lo > ZEP[cat] ? "win" : hi < ZEP[cat] ? "loss" : "tie";
  return `<tr>
    <td class="cat">${esc(cat)}</td>
    <td class="num">${acc === null ? "—" : pct(acc)}</td>
    <td class="num muted">${v ? `${v.correct}/${v.total}` : "—"}</td>
    <td class="num muted">${v ? `${pct(lo)}–${pct(hi)}` : "—"}</td>
    <td class="num ${beat(acc, rival(ZEP_REAL, cat))}">${fmt(rival(ZEP_REAL, cat))}</td>
    <td class="num ${beat(acc, rival(MEM0, cat))}">${fmt(rival(MEM0, cat))}</td>
    <td class="num">${ZEP[cat] === undefined ? "n/a" : pct(ZEP[cat])}</td>
    <td class="muted">${HOLDER[cat] ? esc(HOLDER[cat]) : "—"}</td>
    <td class="num">${FULL_CTX[cat] === undefined ? "n/a" : pct(FULL_CTX[cat])}</td>
    <td class="num ${cls}">${d === null ? "—" : (d >= 0 ? "+" : "") + (d * 100).toFixed(1) + "pp"}</td>
  </tr>`;
}).join("");

const od = latest ? latest.overall.accuracy - ZEP_OVERALL : null;
const [olo, ohi] = latest ? wilson(latest.overall.correct, latest.overall.total) : [0, 0];

const html = `<title>Synapse — LongMemEval progress</title>
<style>
  :root {
    --bg: #fbfbfa; --panel: #fff; --ink: #16150f; --muted: #6b6a63; --line: #e5e4df;
    --win: #1a7f4b; --loss: #b3261e; --tie: #8a6d1f; --accent: #2f5fd0; --ctx: #a8a6a0;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#14140f; --panel:#1c1c17; --ink:#f2f1ea; --muted:#9d9c94; --line:#2e2e28;
      --win:#4ec98a; --loss:#ff8a80; --tie:#e0bd5c; --accent:#8fb0ff; --ctx:#6a6862; }
  }
  :root[data-theme="dark"] { --bg:#14140f; --panel:#1c1c17; --ink:#f2f1ea; --muted:#9d9c94;
    --line:#2e2e28; --win:#4ec98a; --loss:#ff8a80; --tie:#e0bd5c; --accent:#8fb0ff; --ctx:#6a6862; }
  :root[data-theme="light"] { --bg:#fbfbfa; --panel:#fff; --ink:#16150f; --muted:#6b6a63;
    --line:#e5e4df; --win:#1a7f4b; --loss:#b3261e; --tie:#8a6d1f; --accent:#2f5fd0; --ctx:#a8a6a0; }
  body { background: var(--bg); color: var(--ink); margin: 0;
    font: 15px/1.55 ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif; }
  .wrap { max-width: 980px; margin: 0 auto; padding: 40px 20px 80px; }
  h1 { font-size: 26px; margin: 0 0 4px; letter-spacing: -.02em; }
  h2 { font-size: 15px; text-transform: uppercase; letter-spacing: .08em;
    color: var(--muted); margin: 40px 0 12px; font-weight: 600; }
  .sub { color: var(--muted); margin: 0 0 28px; }
  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 18px; }
  .scroll { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
  th, td { padding: 8px 10px; text-align: left; border-bottom: 1px solid var(--line); white-space: nowrap; }
  th { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); font-weight: 600; }
  td.num, th.num { text-align: right; }
  .cat { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
  .muted { color: var(--muted); }
  .win { color: var(--win); font-weight: 600; }
  .loss { color: var(--loss); font-weight: 600; }
  .tie { color: var(--tie); font-weight: 600; }
  .grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px; }
  .card h3 { margin: 0 0 2px; font-size: 13px; font-family: ui-monospace, Menlo, monospace; font-weight: 600; }
  .card .now { font-size: 12px; color: var(--muted); margin-bottom: 6px; }
  svg { width: 100%; height: auto; display: block; }
  .line { fill: none; stroke: var(--accent); stroke-width: 2; }
  .dot { fill: var(--accent); }
  .bar-zep { stroke: var(--loss); stroke-width: 1.5; stroke-dasharray: 4 3; }
  .bar-ctx { stroke: var(--ctx); stroke-width: 1; stroke-dasharray: 2 3; }
  .ax { font-size: 9px; fill: var(--muted); }
  .note { border-left: 3px solid var(--line); padding: 2px 0 2px 14px; color: var(--muted); margin: 14px 0; }
  code { font-family: ui-monospace, Menlo, monospace; font-size: 13px;
    background: var(--panel); border: 1px solid var(--line); border-radius: 4px; padding: 1px 5px; }
  .legend { display: flex; gap: 18px; flex-wrap: wrap; font-size: 12px; color: var(--muted); margin-top: 10px; }
  .sw { display: inline-block; width: 16px; height: 0; border-top-width: 2px; vertical-align: middle; margin-right: 5px; }
</style>
<div class="wrap">
<h1>Synapse on LongMemEval-S</h1>
<p class="sub">Per-category accuracy across tuning rounds, against the best published number from any competing memory system.</p>

<div class="panel">
  <strong>${latest ? pct(latest.overall.accuracy) : "—"}</strong> overall on the
  <strong>dev split</strong> (${latest ? `${latest.overall.correct}/${latest.overall.total}` : "0"} questions)
  &nbsp;·&nbsp; best published ${pct(ZEP_OVERALL)} &nbsp;·&nbsp; full-context gpt-4o ${pct(FULL_CTX_OVERALL)}
  ${latest ? `<div class="muted" style="margin-top:6px">95% CI ${pct(olo)}–${pct(ohi)} &nbsp;·&nbsp; delta vs bar <span class="${od >= 0 ? "win" : "loss"}">${(od >= 0 ? "+" : "") + (od * 100).toFixed(1)}pp</span></div>` : ""}
</div>

<div class="note">
  <strong>Not a leaderboard claim.</strong> These are dev-split numbers, answered and judged by
  <code>${esc(latest?.config?.model ?? "haiku")}</code> via the local Claude CLI. Every rival number is
  vendor self-reported under a different answerer and judge (Gemini 3.1 Pro, GPT-5, GPT-4o), on the full
  500-question set. Judge choice alone moved this project's score by 20pp on identical answers, so
  cross-system deltas smaller than that are not meaningful. The held-out split is the only number
  intended for publication.
</div>

<h2>Latest round — per category</h2>
<div class="panel scroll">
<table>
  <thead><tr>
    <th>category</th><th class="num">synapse</th><th class="num">n</th>
    <th class="num">95% CI</th><th class="num">Zep</th><th class="num">Mem0</th>
    <th class="num">bar</th><th>held by</th><th class="num">full-ctx</th><th class="num">Δ vs bar</th>
  </tr></thead>
  <tbody>${rows}</tbody>
</table>
</div>

<h2>Over rounds (dev)</h2>
<div class="grid">
${CATS.map(
  (cat) => `<div class="card">
    <h3>${esc(cat)}</h3>
    <div class="now">${latest?.byType[cat] ? pct(latest.byType[cat].accuracy) : "—"} now · bar ${ZEP[cat] === undefined ? "n/a" : pct(ZEP[cat]) + " " + HOLDER[cat]}</div>
    ${chart(cat)}
  </div>`,
).join("")}
</div>
<div class="legend">
  <span><span class="sw" style="border-top:2px solid var(--accent)"></span>Synapse</span>
  <span><span class="sw" style="border-top:2px dashed var(--loss)"></span>best published</span>
  <span><span class="sw" style="border-top:2px dashed var(--ctx)"></span>full-context gpt-4o</span>
</div>

<h2>The bar — published rival numbers</h2>
<div class="panel scroll">
<table>
  <thead><tr><th>system</th><th>metric</th><th class="num">overall</th>${CATS.map((c) => `<th class="num">${esc(c.replace("single-session-", "ss-"))}</th>`).join("")}<th>caveat</th></tr></thead>
  <tbody>${BASELINES.providers
    .map(
      (p) => `<tr${p.comparable ? "" : ' class="muted"'}><td class="cat">${esc(p.name)}</td>
      <td class="muted">${esc(p.metric ?? "—")}</td>
      <td class="num">${p.overall == null ? "—" : pct(p.overall)}</td>
      ${CATS.map((c) => `<td class="num">${p.byCategory?.[c] == null ? "—" : pct(p.byCategory[c])}</td>`).join("")}
      <td class="muted" style="white-space:normal;max-width:340px">${esc(p.caveat ?? "")}</td></tr>`,
    )
    .join("")}</tbody>
</table>
</div>
<div class="note">Greyed rows are <strong>not</strong> a target: they measure something else (retrieval recall, oracle split) or publish nothing on LongMemEval. Numbers here are sourced in <code>packages/evals/data/baselines.json</code>.</div>

<h2>Rounds</h2>
<div class="panel scroll">
<table>
  <thead><tr><th>round</th><th>split</th><th class="num">overall</th><th class="num">n</th><th class="num">mins</th><th>config</th><th>what changed</th></tr></thead>
  <tbody>${
    history.length
      ? history
          .map(
            (r) => `<tr><td class="cat">${esc(r.label)}</td><td class="muted">${esc(r.split)}</td>
      <td class="num">${pct(r.overall.accuracy)}</td><td class="num muted">${r.overall.total}</td>
      <td class="num muted">${Math.round((r.elapsedSec ?? 0) / 60)}</td>
      <td class="muted">top=${r.config?.top ?? "?"} minScore=${r.config?.minScore ?? "?"}${r.config?.rerank ? " rerank" : ""} · ${esc(r.config?.model ?? "?")}/${esc(r.config?.judgeModel ?? "same")} judge</td>
      <td class="muted" style="white-space:normal;max-width:320px">${esc(r.note ?? "—")}</td></tr>`,
          )
          .join("")
      : `<tr><td colspan="7" class="muted">No rounds recorded yet.</td></tr>`
  }</tbody>
</table>
</div>
${holdout.length ? "" : `<div class="note">Held-out split (331 questions) not yet run — it is measured once, at the end, and never tuned against.</div>`}
</div>
`;

writeFileSync(out, html);
console.log(`Progress page -> ${out} (${history.length} round(s))`);
