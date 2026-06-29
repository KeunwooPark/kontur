/**
 * Transpile a Kontur IR JSON file to a target language.
 *   npm run transpile -- examples/fizzbuzz.kontur.json ts
 *   npm run transpile -- examples/fizzbuzz.kontur.json python
 */
import { readFileSync } from "node:fs";
import { validateSystem } from "../ir/index.js";
import { transpile, type Target } from "../transpile/index.js";

const [path, targetArg = "ts"] = process.argv.slice(2);
if (!path) {
  console.error("usage: transpile <ir.json> [ts|python]");
  process.exit(2);
}

const target: Target = targetArg === "python" || targetArg === "py" ? "python" : "ts";

let raw: unknown;
try {
  raw = JSON.parse(readFileSync(path, "utf8"));
} catch (err) {
  console.error(`could not read/parse ${path}: ${(err as Error).message}`);
  process.exit(2);
}

const result = validateSystem(raw);
if (!result.ok) {
  console.error(`✗ invalid IR — refusing to transpile (${result.issues.length} issue(s)):`);
  for (const issue of result.issues) console.error(`  ${issue.path}: ${issue.message}`);
  process.exit(1);
}

process.stdout.write(transpile(result.system, target));
