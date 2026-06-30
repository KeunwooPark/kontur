/**
 * A tiny language-neutral AST that sits between the Kontur IR graph and the
 * concrete backends. `compile.ts` lowers the graph into this; each emitter
 * (TS, Python) renders this to source. Keeping it shared means control-flow
 * analysis happens once and the backends only differ in syntax.
 */
import type { Op, SourceSpan } from "../ir/schema.js";

export type { SourceSpan };

export type Expr =
  | { t: "lit"; value: unknown }
  | { t: "var"; name: string }
  /** Member access on a multi-output module-call result: `name.member`. */
  | { t: "member"; name: string; member: string }
  /** Read an attribute of the enclosing class: `this.attr` / `self.attr`. */
  | { t: "stateGet"; attr: string }
  | { t: "bin"; op: Op; a: Expr; b: Expr }
  | { t: "un"; op: Op; x: Expr }
  /** A value-level conditional (ternary): `cond ? then : else`. */
  | { t: "cond"; cond: Expr; then: Expr; else: Expr }
  /** A list literal: `[e0, e1, …]`. */
  | { t: "array"; elems: Expr[] }
  /** A list comprehension over an inclusive range: `[elem for v in from..to]`. */
  | { t: "comprehension"; varName: string; from: Expr; to: Expr; elem: Expr }
  /**
   * A call to a generated function: a helper (stub) or another module. When
   * `external` is set the callee is an imported package symbol — its name is a
   * library API identifier, so it is emitted VERBATIM (no camel/snake re-casing,
   * dotted member access preserved).
   */
  | { t: "call"; name: string; args: Expr[]; external?: boolean };

// `span` is the optional provenance back to source (set by the lifters, ignored
// by the emitters). Intersected over the union so every statement kind carries it
// while still narrowing on `t`.
export type Stmt = { span?: SourceSpan } & (
  | { t: "let"; name: string; expr: Expr }
  /** Reassign an existing binding: `name = expr` / `name += …`. */
  | { t: "assign"; name: string; expr: Expr }
  | { t: "expr"; expr: Expr }
  | { t: "print"; arg: Expr }
  /** Write an attribute of the enclosing class: `this.attr = value`. */
  | { t: "stateSet"; attr: string; value: Expr }
  | { t: "if"; cond: Expr; then: Stmt[]; else: Stmt[] }
  /** Inclusive counted loop: `for v in from..to`. */
  | { t: "for"; varName: string; from: Expr; to: Expr; body: Stmt[] }
  /** Condition-driven loop: `while cond { … }`. */
  | { t: "while"; cond: Expr; body: Stmt[] }
  /** Collection-driven loop: `for varName of iter { … }` / `for varName in iter:`. */
  | { t: "foreach"; varName: string; iter: Expr; body: Stmt[] }
  /**
   * Protected execution: `try { body } catch (catchParam) { handler }`. The
   * IR has catch-all semantics (no exception type); `catchParam` is absent when
   * the source binds no error variable (`catch {}` / bare `except:`).
   */
  | { t: "try"; body: Stmt[]; catchParam?: string; handler: Stmt[] }
  /**
   * Raise an exception carrying a message expression. Terminal: control escapes,
   * so nothing falls through after it. `errorType` names the error constructor for
   * a typed/custom error; absent ⇒ the catch-all `Error`/`Exception` (the raising
   * counterpart of the catch-all `try`). Each backend wraps `arg` in that
   * constructor (`throw new <errorType>(arg)` / `raise <errorType>(arg)`).
   */
  | { t: "throw"; arg: Expr; errorType?: string }
  /**
   * Re-raise an existing exception value unchanged (`throw e` / `raise e`).
   * Terminal, like `throw`, but the value is passed on AS-IS — no error
   * constructor wraps it. `value` is the exception being re-raised (typically the
   * enclosing catch binding).
   */
  | { t: "rethrow"; value: Expr }
  | { t: "return"; expr: Expr }
  /** Return several named values (multi-output module). */
  | { t: "returnObject"; fields: { name: string; expr: Expr }[] }
);

export interface Param {
  name: string;
  /** IR type label (e.g. "int", "User"); emitters map it per backend. */
  type: string;
}

export interface Fn {
  /** Source module id (cased per backend at emit time). */
  name: string;
  params: Param[];
  /** Data out-port types, in declared order. Empty → no return value. */
  returns: { name: string; type: string }[];
  body: Stmt[];
  /** When true, emit as a class method (no `export function`, `self`/`this`). */
  isMethod?: boolean;
  /** Provenance back to the function/method definition (lifters only). */
  span?: SourceSpan;
}

/** A class attribute: a typed, stored cell. */
export interface Field {
  name: string;
  type: string;
}

/** A class: stored state (attributes) plus methods (each a module/Fn). */
export interface Class {
  /** Source class id (cased to PascalCase at emit time). */
  name: string;
  fields: Field[];
  methods: Fn[];
  /** Provenance back to the class definition (lifters only). */
  span?: SourceSpan;
}

/**
 * One binding introduced by an import statement. `local` is the name visible in
 * the body; `imported` (named only) is the name on the package side, so an alias
 * (`import { a as b }`) round-trips. A `default` import has no package-side name;
 * a `namespace` import (`* as ns` / `import mod`) binds the whole module object.
 */
export type ImportBinding =
  | { kind: "named"; imported: string; local: string }
  | { kind: "default"; local: string }
  | { kind: "namespace"; local: string };

/**
 * A single import statement. `source` is the module specifier (e.g. "lodash",
 * "./util", "os"). An empty `bindings` is a bare side-effect import (`import "x"`).
 * Captured verbatim so the transpiler can reproduce it — fidelity, not analysis.
 */
export interface Import {
  source: string;
  bindings: ImportBinding[];
  /** Provenance back to the import statement (lifters that track spans). */
  span?: SourceSpan;
}

export interface Program {
  functions: Fn[];
  classes: Class[];
  /** Imports in source order. Optional for back-compat with older callers. */
  imports?: Import[];
}
