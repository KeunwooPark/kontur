/** Kontur transpiler — public surface. IR → target source. */
export { compile } from "./compile.js";
export { emitTypeScript } from "./emit-ts.js";
export { emitPython } from "./emit-python.js";
export type { Program, Fn, Stmt, Expr } from "./ast.js";

import type { System } from "../ir/schema.js";
import { compile } from "./compile.js";
import { emitTypeScript } from "./emit-ts.js";
import { emitPython } from "./emit-python.js";

export type Target = "ts" | "python";

/** Convenience: validated System → source string for a target. */
export function transpile(system: System, target: Target): string {
  const program = compile(system);
  return target === "ts" ? emitTypeScript(program) : emitPython(program);
}

/**
 * Multi-file transpile: a validated System → one source string per origin file,
 * keyed by the project-relative path. Each file emits only its own modules and
 * imports, while cross-file links still resolve against the whole System. The
 * inverse of the project lifter — `liftProject` then `transpileProject` must
 * reproduce every file (round-trip fidelity, now per file rather than per
 * System). Modules with no `origin` (a single-file or hand-authored System) all
 * land under the "" key.
 */
export function transpileProject(system: System, target: Target): Map<string, string> {
  const origins = new Set<string>();
  for (const mod of Object.values(system.modules)) origins.add(mod.origin ?? "");
  const out = new Map<string, string>();
  for (const origin of origins) {
    const program = compile(system, origin);
    out.set(origin, target === "ts" ? emitTypeScript(program) : emitPython(program));
  }
  return out;
}
