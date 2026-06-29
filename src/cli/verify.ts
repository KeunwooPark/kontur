/**
 * Verify lifted code node-by-node with a real model, and print a coverage map.
 *   npm run verify -- path/to/file.py [moduleId] [nodeId]
 * With no module/node, every provenance-bearing node is verified concurrently.
 * Needs ANTHROPIC_API_KEY (or an `ant auth login` profile). Override the model
 * with KONTUR_VERIFY_MODEL (e.g. claude-haiku-4-5 for cheap fan-out).
 */
import { readFileSync } from "node:fs";
import { liftPython, liftTypeScript } from "../lift/index.js";
import { extractSlice, renderVerificationPrompt, type VerificationSlice } from "../verify/index.js";
import { anthropicVerifier } from "../verify/anthropic.js";
import type { Verdict } from "../verify/index.js";

const [path, moduleId, nodeId] = process.argv.slice(2);
if (!path) {
  console.error("usage: verify <file.ts|file.py> [moduleId] [nodeId]");
  process.exit(2);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("verify: set ANTHROPIC_API_KEY (or run `ant auth login`) first.");
  process.exit(2);
}

const source = readFileSync(path, "utf8");
const system = path.endsWith(".py") ? liftPython(source) : liftTypeScript(source);
const model = process.env.KONTUR_VERIFY_MODEL;
const verifier = anthropicVerifier(model ? { model } : {});

const mark = (v: Verdict) => (v.ok ? "✓ ok     " : "✗ suspect");
const label = (s: VerificationSlice) => s.target.source ?? `${s.target.label} [${s.target.kind}]`;

// Collect the nodes to verify: one, or every provenance-bearing node.
const targets: { moduleId: string; nodeId: string }[] = [];
if (moduleId && nodeId) {
  targets.push({ moduleId, nodeId });
} else {
  for (const [mid, mod] of Object.entries(system.modules)) {
    for (const node of mod.interior.nodes) if (node.prov) targets.push({ moduleId: mid, nodeId: node.id });
  }
}

const results = await Promise.all(
  targets.map(async (t) => {
    const slice = extractSlice(system, t.moduleId, t.nodeId, source);
    const verdict = await verifier(renderVerificationPrompt(slice));
    return { ...t, slice, verdict };
  }),
);

let suspects = 0;
let current = "";
for (const r of results) {
  if (r.moduleId !== current) {
    current = r.moduleId;
    console.log(`\n▸ ${current}`);
  }
  if (!r.verdict.ok) suspects++;
  console.log(`  ${mark(r.verdict)}  ${r.nodeId.padEnd(6)} ${JSON.stringify(label(r.slice))}`);
  console.log(`             ↳ ${r.verdict.reason}`);
}

console.log(`\n${results.length} node(s) verified, ${suspects} suspect.`);
process.exit(suspects > 0 ? 1 : 0);
