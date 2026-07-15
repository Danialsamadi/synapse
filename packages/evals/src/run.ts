import { runEvals } from "./harness.js";

const summary = await runEvals(5);
console.log(`\n| case | family | P@5 | stale | pass |\n|------|--------|-----|-------|------|`);
for (const r of summary.results) {
  console.log(`| ${r.caseId} | ${r.family} | ${r.precisionAtK.toFixed(2)} | ${r.staleHit ? "STALE" : "-"} | ${r.pass ? "PASS" : "FAIL"} |`);
}
console.log(`\nprecision@5=${summary.precisionAtK.toFixed(3)} staleFactRate=${summary.staleFactRate.toFixed(3)} passRate=${summary.passRate.toFixed(3)}`);
if (summary.staleFactRate > 0 || summary.passRate < 0.8) process.exit(1);
