/**
 * Lift an existing source file into Kontur IR (one-time import).
 *   npm run lift -- path/to/file.ts
 *   npm run lift -- path/to/file.py
 * Language is inferred from the extension. Prints the validated IR as JSON.
 */
import { readFileSync } from "node:fs";
import { validateSystem } from "../ir/index.js";
import { liftPython, liftTypeScript } from "../lift/index.js";

const path = process.argv[2];
if (!path) {
  console.error("usage: lift <file.ts|file.py>");
  process.exit(2);
}

const source = readFileSync(path, "utf8");
let system;
try {
  system = path.endsWith(".py") ? liftPython(source) : liftTypeScript(source);
} catch (err) {
  console.error(`✗ ${(err as Error).message}`);
  process.exit(1);
}

const result = validateSystem(system);
if (!result.ok) {
  console.error(`✗ lifted IR failed validation (${result.issues.length} issue(s)):`);
  for (const issue of result.issues) console.error(`  ${issue.path}: ${issue.message}`);
  process.exit(1);
}

process.stdout.write(JSON.stringify(result.system, null, 2) + "\n");
