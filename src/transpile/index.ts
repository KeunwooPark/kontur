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
