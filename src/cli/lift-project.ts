/**
 * Lift a multi-file project into one Kontur IR System.
 *   npm run lift:project -- src/main.ts [more/entries.ts ...]
 *   npm run lift:project -- --root src src/main.ts
 *
 * Entry files seed the navigation tree (their top-level declarations become
 * features); local imports are followed transitively and rendered as descendable
 * links, while third-party imports stay boundary crossings. Module ids are
 * qualified by their path relative to --root (default: the current directory).
 * Prints the validated IR as JSON.
 */
import { resolve } from "node:path";
import { validateSystem } from "../ir/index.js";
import { liftProject } from "../lift/index.js";

const argv = process.argv.slice(2);
let root = process.cwd();
const entries: string[] = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--root") {
    root = resolve(argv[++i] ?? ".");
  } else {
    entries.push(resolve(argv[i]!));
  }
}

if (entries.length === 0) {
  console.error("usage: lift:project [--root <dir>] <entry.ts|entry.py> [more entries ...]");
  process.exit(2);
}

let system;
try {
  system = liftProject({ root, entries });
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
