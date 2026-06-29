/**
 * Kontur lifter — source → IR. The inverse of the transpiler, for the one-time
 * import of existing code into Kontur. (Not a round-trip: once lifted, the IR is
 * the source of truth and the code is regenerated from it, never lifted again.)
 */
import type { System } from "../ir/schema.js";
import { parseTypeScript } from "./ast-from-ts.js";
import { parsePython } from "./ast-from-python.js";
import { liftProgram } from "./to-ir.js";

export { liftProgram };
export { parseTypeScript, parsePython };

export function liftTypeScript(source: string): System {
  return liftProgram(parseTypeScript(source));
}

export function liftPython(source: string): System {
  return liftProgram(parsePython(source));
}
