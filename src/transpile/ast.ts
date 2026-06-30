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

/**
 * A parameter default — a literal or a bare name reference, the subset the IR
 * carries (see `ParamDefault` in ir/schema.ts). A subtype of `Expr`, so the
 * emitters render it with their existing `expr()`.
 */
export type DefaultValue =
  | { t: "lit"; value: string | number | boolean | null }
  | { t: "var"; name: string };

export interface Param {
  name: string;
  /** IR type label (e.g. "int", "User"); emitters map it per backend. "any" ⇒
   *  no annotation in source (an unannotated `*args` / `def f(x):`). */
  type: string;
  /** Default value (`x = 1`), absent when the parameter is required. */
  default?: DefaultValue;
  /** `*args` ("args") / `**kwargs` ("kwargs") / TS rest ("args"). */
  variadic?: "args" | "kwargs";
  /** A Python keyword-only parameter (declared after `*`). */
  keywordOnly?: boolean;
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
  /**
   * Decorators applied to the function/method, outermost first — each the
   * decorator expression carried VERBATIM without its leading `@` (`property`,
   * `app.route('/x')`, `functools.wraps(fn)`), like `Class.bases`: opaque
   * metadata the IR passes across backends, not analysed. Emitted as `@<text>`
   * lines above the definition. Absent ⇒ no decorator. The receiver-altering
   * `@staticmethod` / `@classmethod` are refused at lift time, not carried here.
   */
  decorators?: string[];
  /**
   * The captured docstring — a Python PEP 257 docstring or a TS JSDoc block. Held
   * as the human text only (no quotes/asterisks); each emitter re-wraps it in its
   * own syntax so it round-trips. Absent ⇒ the source carried no doc.
   */
  doc?: string;
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
  /**
   * Base classes (inheritance), in declared order — each a name or dotted name
   * (`RequestException`, `collections.abc.MutableMapping`). Emitted VERBATIM, like
   * any other type identifier (cf. `Stmt`'s `throw.errorType`): Python renders all
   * as positional bases `class C(A, B):`; TS renders them as `extends A` (single
   * inheritance — TS cannot express more than one). Absent ⇒ no base class.
   */
  bases?: string[];
  /** Decorators applied to the class, outermost first — verbatim, sans `@`; see
   *  `Fn.decorators`. Absent ⇒ no decorator. */
  decorators?: string[];
  /** The captured class docstring (human text only); see `Fn.doc`. */
  doc?: string;
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
