/**
 * Print the verification slice for one IR node lifted from a source file.
 *   npm run slice -- path/to/file.py <moduleId> <nodeId>
 * With no <moduleId>/<nodeId>, lists every provenance-bearing node so you can
 * pick one. Language is inferred from the extension.
 */
import { readFileSync } from "node:fs";
import { liftPython, liftTypeScript } from "../lift/index.js";
import { extractSlice, renderVerificationPrompt } from "../verify/index.js";

const [path, moduleId, nodeId] = process.argv.slice(2);
if (!path) {
  console.error("usage: slice <file.ts|file.py> [moduleId] [nodeId]");
  process.exit(2);
}

const source = readFileSync(path, "utf8");
const system = path.endsWith(".py") ? liftPython(source) : liftTypeScript(source);

if (!moduleId || !nodeId) {
  console.error("Pick a node (module / node / source):\n");
  for (const [id, mod] of Object.entries(system.modules)) {
    for (const node of mod.interior.nodes) {
      if (!node.prov) continue;
      const where = `${id}  ${node.id}`.padEnd(28);
      console.error(`  ${where} ${node.kind}`);
    }
  }
  process.exit(1);
}

const slice = extractSlice(system, moduleId, nodeId, source);
process.stdout.write(renderVerificationPrompt(slice) + "\n");
