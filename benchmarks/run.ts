/**
 * Kontur benchmark runner.
 *
 * Drives every case in manifest.json through the real pipeline and scores it:
 *
 *   supported case (expect: "roundtrip")
 *     source -> lift -> validate -> transpile (codeA)
 *            -> lift(codeA) -> transpile (codeB)
 *     PASS iff every stage succeeds AND codeA === codeB (round-trip fixed point).
 *     Also cross-transpiles to the other backend and renders the IR to HTML so
 *     the visualizations can be inspected ("learn how they visualized them").
 *
 *   unsupported case (expect: "reject")
 *     PASS iff lift throws. A lift that *succeeds* here is a fail-closed
 *     violation (silent data loss) and is flagged.
 *
 * Outputs: a console scoreboard, benchmarks/out/REPORT.md, benchmarks/out/<id>.html
 * per rendered case, and benchmarks/out/index.html linking them all.
 *
 *   npm run bench
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { validateSystem } from "../src/ir/index.js";
import { liftTypeScript, liftPython } from "../src/lift/index.js";
import { transpile, type Target } from "../src/transpile/index.js";
import { render } from "../src/render/index.js";
import type { System } from "../src/ir/schema.js";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "out");
mkdirSync(outDir, { recursive: true });

interface CaseSpec {
  id: string;
  file: string;
  expect: "roundtrip" | "reject";
  feature: string;
  title: string;
  note: string;
}
const manifest = JSON.parse(readFileSync(join(here, "manifest.json"), "utf8")) as {
  description: string;
  cases: CaseSpec[];
};

const hasPython = (() => {
  try { execFileSync("python3", ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
})();

const lift = (source: string, lang: Lang): System =>
  lang === "py" ? liftPython(source) : liftTypeScript(source);
const targetOf = (lang: Lang): Target => (lang === "py" ? "python" : "ts");

type Lang = "ts" | "py";
type Status = "pass" | "fail" | "skip";

interface Result {
  spec: CaseSpec;
  lang: Lang;
  status: Status;
  stages: Record<string, string>;
  notes: string[];
  codeA?: string;
  rendered?: string; // output html filename
}

function runRoundtrip(spec: CaseSpec, lang: Lang, source: string): Result {
  const r: Result = { spec, lang, status: "fail", stages: {}, notes: [] };
  let system: System;
  try {
    const lifted = lift(source, lang);
    r.stages.lift = "ok";
    const v = validateSystem(lifted);
    if (!v.ok) {
      r.stages.validate = "FAIL";
      r.notes.push(...v.issues.map((i) => `validate ${i.path}: ${i.message}`));
      return r;
    }
    r.stages.validate = "ok";
    system = v.system;
  } catch (e) {
    r.stages.lift = "FAIL";
    r.notes.push(`lift threw: ${(e as Error).message}`);
    return r;
  }

  const tgt = targetOf(lang);
  let codeA: string;
  try {
    codeA = transpile(system, tgt);
    r.codeA = codeA;
    r.stages.transpile = "ok";
  } catch (e) {
    r.stages.transpile = "FAIL";
    r.notes.push(`transpile threw: ${(e as Error).message}`);
    return r;
  }

  try {
    const lifted2 = lift(codeA, lang);
    const v2 = validateSystem(lifted2);
    if (!v2.ok) {
      r.stages.roundtrip = "FAIL";
      r.notes.push("re-lift of transpiled code failed validation");
      return r;
    }
    const codeB = transpile(v2.system, tgt);
    if (codeB === codeA) {
      r.stages.roundtrip = "ok";
    } else {
      r.stages.roundtrip = "FAIL";
      r.notes.push("round-trip not a fixed point: codeA !== codeB");
      writeFileSync(join(outDir, `${spec.id}.codeA.txt`), codeA);
      writeFileSync(join(outDir, `${spec.id}.codeB.txt`), codeB);
    }
  } catch (e) {
    r.stages.roundtrip = "FAIL";
    r.notes.push(`re-lift threw: ${(e as Error).message}`);
    return r;
  }

  // Cross-transpile to the other backend (sanity: the IR feeds both).
  try {
    transpile(system, tgt === "ts" ? "python" : "ts");
    r.stages.cross = "ok";
  } catch (e) {
    r.stages.cross = "FAIL";
    r.notes.push(`cross-transpile threw: ${(e as Error).message}`);
  }

  r.status = r.stages.roundtrip === "ok" ? "pass" : "fail";
  return r;
}

async function renderCase(spec: CaseSpec, system: System): Promise<string | undefined> {
  try {
    const html = await render(system);
    const fname = `${spec.id}.html`;
    writeFileSync(join(outDir, fname), html);
    return fname;
  } catch {
    return undefined;
  }
}

function runReject(spec: CaseSpec, lang: Lang, source: string): Result {
  const r: Result = { spec, lang, status: "fail", stages: {}, notes: [] };
  try {
    const lifted = lift(source, lang);
    // Lift did not throw. Inspect whether it silently produced an (empty) system.
    const v = validateSystem(lifted);
    const moduleCount = v.ok ? Object.keys(v.system.modules).length : 0;
    r.stages.lift = "UNEXPECTED-OK";
    r.status = "fail";
    if (moduleCount === 0) {
      r.notes.push("FAIL-CLOSED VIOLATION: lift succeeded but produced an EMPTY system — code silently dropped.");
    } else {
      r.notes.push(`expected rejection but lift produced ${moduleCount} module(s).`);
    }
  } catch (e) {
    r.stages.lift = "rejected";
    r.notes.push(`rejected: ${(e as Error).message.split("\n")[0]}`);
    r.status = "pass";
  }
  return r;
}

const results: Result[] = [];
for (const spec of manifest.cases) {
  const lang: Lang = spec.file.endsWith(".py") ? "py" : "ts";
  if (lang === "py" && !hasPython) {
    results.push({ spec, lang, status: "skip", stages: { lift: "skip (no python3)" }, notes: [] });
    continue;
  }
  const source = readFileSync(join(here, spec.file), "utf8");
  if (spec.expect === "roundtrip") {
    const r = runRoundtrip(spec, lang, source);
    if (r.stages.validate === "ok") {
      const lifted = lift(source, lang); // cheap; re-lift for a clean system to render
      const v = validateSystem(lifted);
      if (v.ok) r.rendered = await renderCase(spec, v.system);
    }
    results.push(r);
  } else {
    results.push(runReject(spec, lang, source));
  }
}

// ---- console scoreboard ----------------------------------------------------
const icon = (s: Status) => (s === "pass" ? "✓" : s === "skip" ? "–" : "✗");
const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length));

console.log(`\nKontur benchmark — ${manifest.cases.length} cases\n`);
console.log(`  ${pad("", 1)} ${pad("id", 22)} ${pad("lang", 5)} ${pad("expect", 10)} stages`);
console.log("  " + "-".repeat(78));
for (const r of results) {
  const stages = Object.entries(r.stages).map(([k, v]) => `${k}:${v}`).join("  ");
  console.log(`  ${icon(r.status)} ${pad(r.spec.id, 22)} ${pad(r.lang, 5)} ${pad(r.spec.expect, 10)} ${stages}`);
  for (const n of r.notes) console.log(`      ↳ ${n}`);
}

const pass = results.filter((r) => r.status === "pass").length;
const fail = results.filter((r) => r.status === "fail").length;
const skip = results.filter((r) => r.status === "skip").length;
console.log("\n  " + "-".repeat(78));
console.log(`  ${pass} passed   ${fail} failed   ${skip} skipped   (of ${results.length})\n`);

// ---- REPORT.md -------------------------------------------------------------
const md: string[] = [];
md.push(`# Kontur benchmark report`, "");
md.push(manifest.description, "");
md.push(`**${pass} passed · ${fail} failed · ${skip} skipped** of ${results.length} cases.`, "");
md.push(`| | id | lang | expect | result | stages | notes |`);
md.push(`|---|---|---|---|---|---|---|`);
for (const r of results) {
  const stages = Object.entries(r.stages).map(([k, v]) => `${k}:${v}`).join("<br>");
  const notes = r.notes.join("<br>") || "—";
  md.push(`| ${icon(r.status)} | \`${r.spec.id}\` | ${r.lang} | ${r.spec.expect} | ${r.status} | ${stages} | ${notes} |`);
}
md.push("", "## Cases", "");
for (const r of results) {
  md.push(`### ${icon(r.status)} ${r.spec.id} — ${r.spec.title}`, "");
  md.push(`*feature:* ${r.spec.feature} · *expect:* ${r.spec.expect} · *result:* **${r.status}**`, "");
  md.push(r.spec.note, "");
  if (r.rendered) md.push(`Rendered diagram: [\`out/${r.rendered}\`](./${r.rendered})`, "");
  if (r.codeA) {
    md.push("Transpiled output (canonical form):", "", "```" + (r.lang === "py" ? "python" : "ts"), r.codeA.trimEnd(), "```", "");
  }
}
writeFileSync(join(outDir, "REPORT.md"), md.join("\n"));

// ---- index.html (gallery of diagrams) --------------------------------------
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const cards = results
  .map((r) => {
    const link = r.rendered
      ? `<a href="./${r.rendered}">open diagram →</a>`
      : `<span class="muted">no diagram</span>`;
    const code = r.codeA ? `<pre>${esc(r.codeA.trimEnd())}</pre>` : "";
    const cls = r.status === "pass" ? "pass" : r.status === "skip" ? "skip" : "fail";
    const notes = r.notes.length ? `<ul class="notes">${r.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : "";
    return `<section class="card ${cls}">
  <h2>${icon(r.status)} ${r.spec.id} <small>${r.spec.feature} · ${r.lang} · expect ${r.spec.expect}</small></h2>
  <p>${esc(r.spec.note)}</p>
  ${link}
  ${notes}
  ${code}
</section>`;
  })
  .join("\n");
const indexHtml = `<!doctype html><meta charset="utf-8"><title>Kontur benchmark</title>
<style>
  body{font:14px/1.5 ui-sans-serif,system-ui,sans-serif;max-width:920px;margin:2rem auto;padding:0 1rem;color:#1a1a1a}
  h1{margin-bottom:.2rem} .summary{color:#555;margin-bottom:1.5rem}
  .card{border:1px solid #ddd;border-left-width:5px;border-radius:6px;padding:1rem 1.2rem;margin:1rem 0}
  .card.pass{border-left-color:#3a7d44} .card.fail{border-left-color:#b23a3a} .card.skip{border-left-color:#999}
  .card h2{font-size:1rem;margin:0 0 .3rem} .card h2 small{font-weight:400;color:#777;font-size:.8rem}
  pre{background:#f6f6f4;padding:.7rem;border-radius:4px;overflow:auto;font-size:12px}
  .notes{color:#b23a3a;margin:.4rem 0} .muted{color:#999} a{color:#2a5db0}
</style>
<h1>Kontur benchmark</h1>
<p class="summary">${pass} passed · ${fail} failed · ${skip} skipped of ${results.length} cases. ${esc(manifest.description)}</p>
${cards}
`;
writeFileSync(join(outDir, "index.html"), indexHtml);

console.log(`  report:   benchmarks/out/REPORT.md`);
console.log(`  gallery:  benchmarks/out/index.html`);
console.log(`  diagrams: benchmarks/out/<id>.html\n`);

if (fail > 0) process.exitCode = 1;
