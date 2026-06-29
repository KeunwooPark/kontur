/**
 * Tiny CLI: validate a Kontur IR JSON file.
 *   npm run validate -- examples/auth-search.kontur.json
 */
import { readFileSync } from "node:fs";
import { validateSystem } from "../ir/index.js";

const path = process.argv[2];
if (!path) {
  console.error("usage: validate <ir.json>");
  process.exit(2);
}

let raw: unknown;
try {
  raw = JSON.parse(readFileSync(path, "utf8"));
} catch (err) {
  console.error(`could not read/parse ${path}: ${(err as Error).message}`);
  process.exit(2);
}

const result = validateSystem(raw);
if (result.ok) {
  const count = Object.keys(result.system.modules).length;
  console.log(`✓ valid — ${count} module(s), features: ${result.system.features.join(", ")}`);
  process.exit(0);
}

console.error(`✗ invalid — ${result.issues.length} issue(s):`);
for (const issue of result.issues) {
  console.error(`  ${issue.path}: ${issue.message}`);
}
process.exit(1);
