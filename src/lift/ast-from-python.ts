/**
 * Parse a Python source string into the neutral AST (ast.ts) by delegating to
 * Python's own `ast` module via a subprocess. Reusing the real parser keeps us
 * honest and avoids reimplementing Python grammar in TS.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Program } from "../transpile/ast.js";

export function parsePython(source: string): Program {
  const script = fileURLToPath(new URL("./extract_ast.py", import.meta.url));
  const out = execFileSync("python3", [script], { input: source, encoding: "utf8" });
  return JSON.parse(out) as Program;
}
