/**
 * Lift every supported source file under a directory into one Kontur IR System.
 *   npm run lift:dir -- path/to/project
 *
 * Walks the tree (skipping deps/build/test/declaration files), lifts what fits
 * the supported subset, and reports what it skipped — coverage is never silently
 * lossy. Navigation roots (modules nothing else links to) become the features.
 * Prints the validated IR as JSON to stdout; skip reasons go to stderr.
 */
import { resolve } from "node:path";
import { validateSystem } from "../ir/index.js";
import { liftDirectory } from "../lift/index.js";

const root = process.argv[2] ? resolve(process.argv[2]) : process.cwd();

let result;
try {
  result = liftDirectory(root);
} catch (err) {
  console.error(`✗ ${(err as Error).message}`);
  process.exit(1);
}

// Report skipped files loudly (never silently drop coverage).
for (const s of result.skipped) {
  console.error(`⤬ skipped ${s.file} (${s.phase}): ${s.message}`);
}

const validated = validateSystem(result.system);
if (!validated.ok) {
  console.error(`✗ lifted IR failed validation (${validated.issues.length} issue(s)):`);
  for (const issue of validated.issues) console.error(`  ${issue.path}: ${issue.message}`);
  process.exit(1);
}

const modCount = Object.keys(validated.system.modules).length;
console.error(`✓ lifted ${modCount} module(s) from ${root}; ${result.skipped.length} file(s) skipped`);
process.stdout.write(JSON.stringify(validated.system, null, 2) + "\n");
