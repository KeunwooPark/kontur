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
  /** The ambient method receiver: `self` (Python) / `this` (TS). Only ever the
   *  receiver of a method call or the base of an attribute read — never a value
   *  on its own (a bare `self` is refused at lift time). */
  | { t: "self" }
  /** Member access on a multi-output module-call result: `name.member`. */
  | { t: "member"; name: string; member: string }
  /** A general attribute read on a receiver: `obj.name` (the receiver may itself
   *  be any expression — a var, a call result, a nested attr). Distinct from
   *  `member` (a dict/record field of a multi-output result) and from `stateGet`
   *  (the enclosing class's own `self.attr`). */
  | { t: "attr"; obj: Expr; name: string }
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
  /** A comprehension over an arbitrary iterable, building a list/set/dict/generator:
   *  `[elem for v in iter if cond]`, `{key: value for v in iter}`, `{elem for …}`,
   *  `(elem for …)`. The iterable sibling of the counted-range `comprehension`.
   *  `cond` is an optional `if` filter; `key`/`value` are set for the dict form,
   *  `elem` for the others. `varNames` (≥2) replaces `varName` when the target is
   *  a tuple-unpack (`{k: v for k, v in items}`). Exactly one of `varName`/`varNames`. */
  | { t: "itercomp"; form: "list" | "set" | "dict" | "generator"; varName?: string; varNames?: string[]; iter: Expr; cond?: Expr; elem?: Expr; key?: Expr; value?: Expr }
  /** A tuple `(e0, e1, …)`, set `{e0, …}`, or dict `{k0: v0, …}` literal — the
   *  sibling of `array` (the list literal) for the other built-in collection
   *  types. `form` selects which; `elems` holds the elements for tuple/set,
   *  `entries` the ordered key/value pairs for dict (mirroring `itercomp`'s
   *  elem-vs-key/value split). An empty literal carries an empty `elems`/`entries`. */
  | { t: "collection"; form: "tuple" | "set" | "dict"; elems?: Expr[]; entries?: { key: Expr; value: Expr }[] }
  /** A subscript read `obj[key]`: index a list/dict/string by an arbitrary key
   *  expression. The receiver `obj` may be any expression. Distinct from `member`
   *  (a static field of a multi-output result, keyed by a constant STRING port
   *  name); `index` is the general runtime subscript, emitted `obj[key]` in both
   *  Python and TS — a symmetric, fixed-point construct in either language. */
  | { t: "index"; obj: Expr; key: Expr }
  /** A slice read `obj[start:stop]` — either bound may be absent (`obj[:3]`,
   *  `obj[1:]`, `obj[:]`). Python renders it faithfully (a source fixed point);
   *  TS has no slice syntax, so it cross-compiles ONE-WAY to `obj.slice(start,
   *  stop)`. A step slice (`obj[::2]`) is refused at lift (deferred). */
  | { t: "slice"; obj: Expr; start?: Expr; stop?: Expr; step?: Expr }
  /**
   * A call to a generated function: a helper (stub) or another module. When
   * `external` is set the callee is an imported package symbol — its name is a
   * library API identifier, so it is emitted VERBATIM (no camel/snake re-casing,
   * dotted member access preserved). When `recv` is set this is a METHOD call —
   * `recv.name(args)` — and `name` is the method name (emitted verbatim, like an
   * attribute); a `self`/`this` receiver round-trips as the `self` expr.
   */
  /** Await an awaitable: `await value` (only inside an async function). A pure
   *  value transform — the awaited result flows out. */
  | { t: "await"; value: Expr }
  /** A reference to a module-level constant (a free identifier). Emitted verbatim
   *  (the name must match its module-scope declaration); the constant itself is
   *  re-declared at module scope from `Program.consts`. */
  | { t: "global"; name: string }
  | { t: "call"; name: string; args: Expr[]; recv?: Expr; external?: boolean;
      /** `*x` positional-unpack arguments, in order (`f(*a, *b)`). */
      starArgs?: Expr[];
      /** Keyword arguments: `name=value` (name a string) or `**value` dict-unpack
       *  (name null). Emitted after positional/star args. */
      kwargs?: { name: string | null; value: Expr }[] };

// `span` is the optional provenance back to source (set by the lifters, ignored
// by the emitters). Intersected over the union so every statement kind carries it
// while still narrowing on `t`.
export type Stmt = { span?: SourceSpan } & (
  | { t: "let"; name: string; expr: Expr; mutable?: boolean }
  /** Reassign an existing binding: `name = expr` / `name += …`. */
  | { t: "assign"; name: string; expr: Expr }
  | { t: "expr"; expr: Expr }
  | { t: "print"; arg: Expr }
  /** Write an attribute of the enclosing class: `this.attr = value`. */
  | { t: "stateSet"; attr: string; value: Expr }
  /** Write an attribute on an arbitrary receiver: `obj.attr = value`. The
   *  write-side counterpart of an `attr` read; distinct from `stateSet` (the
   *  enclosing class's own `self.attr`), the receiver `obj` may be any expression. */
  | { t: "attrSet"; obj: Expr; attr: string; value: Expr }
  /** Write an indexed element: `obj[key] = value` — the write-side counterpart of
   *  an `index` read. The general subscript-assignment lvalue. */
  | { t: "indexSet"; obj: Expr; key: Expr; value: Expr }
  /** Delete an indexed element: `del obj[key]` (Python) / `delete obj[key]` (TS).
   *  A control-sequenced effect, no value. */
  | { t: "delIndex"; obj: Expr; key: Expr }
  /** Delete an attribute: `del obj.attr` (Python) / `delete obj.attr` (TS). */
  | { t: "delAttr"; obj: Expr; attr: string }
  /** Sequence-unpacking assignment: `a, b, … = value`. Each name binds to the
   *  corresponding element of `value` (a sequence); `value` is evaluated once.
   *  Python renders it `a, b = value`, TS `const [a, b] = value`. At least two
   *  names (a single target is a plain `let`); starred / nested targets are
   *  refused at lift. */
  | { t: "destructure"; names: string[]; value: Expr }
  /** Chained assignment: `x = y = z` — one value bound to several names (≥2),
   *  evaluated once. Distinct from `destructure` (which splits a sequence into
   *  element-wise parts); here every name gets the WHOLE value. */
  | { t: "chain"; names: string[]; value: Expr }
  | { t: "if"; cond: Expr; then: Stmt[]; else: Stmt[] }
  /** Inclusive counted loop: `for v in from..to`. */
  | { t: "for"; varName: string; from: Expr; to: Expr; body: Stmt[] }
  /** Condition-driven loop: `while cond { … }`. */
  | { t: "while"; cond: Expr; body: Stmt[] }
  /** Collection-driven loop: `for varName of iter { … }` / `for varName in iter:`.
   *  `names` (≥2) replaces `varName` when the loop target is a tuple-unpack
   *  (`for k, v in items:` / `for (const [k, v] of …)`); `varName` is then ignored.
   *  Each name binds the corresponding element of the iterated tuple per iteration.
   *  Exactly one of `varName` / `names` is present. */
  | { t: "foreach"; varName?: string; names?: string[]; iter: Expr; body: Stmt[] }
  /**
   * Protected execution: `try { body } catch (catchParam) { handler }`. The
   * handler is catch-all unless `errorTypes` names the exception type(s) it
   * catches (`except ValueError:` → ["ValueError"], `except (A, B):` →
   * ["A", "B"]); `catchParam` is absent when the source binds no error variable
   * (`catch {}` / bare `except:`). `orelse` runs when the body raised nothing
   * (Python `try/else`); `finalbody` always runs on the way out (`finally`).
   */
  | { t: "try"; body: Stmt[]; catchParam?: string; errorTypes?: string[]; handler: Stmt[]; orelse?: Stmt[]; finalbody?: Stmt[] }
  /**
   * A context-managed block: `with context as resource: body` (Python). The
   * context manager `context` is entered, its value bound to `resource` (absent
   * for `with context:` / no `as`), the `body` runs, and the manager exits on the
   * way out. Python renders it faithfully (a source fixed point); TS has no `with`
   * context-manager, so it cross-compiles ONE-WAY to a `using` disposable block.
   */
  | { t: "with"; context: Expr; resource?: string; body: Stmt[] }
  /**
   * An assertion: `assert cond` / `assert cond, message`. A control-sequenced
   * effect that raises when `cond` is falsy. Python renders it faithfully; TS has
   * no `assert` statement, so it cross-compiles ONE-WAY to `console.assert(...)`.
   */
  | { t: "assert"; cond: Expr; message?: Expr }
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
  | { t: "rethrow"; value?: Expr }
  /** Return a value, or a bare `return` (void early exit) when `expr` is absent. */
  | { t: "return"; expr?: Expr }
  /** Return several named values (multi-output module). */
  | { t: "returnObject"; fields: { name: string; expr: Expr }[] }
  /** Exit the nearest enclosing loop (`break`). Terminal: control leaves the
   *  block, so nothing falls through after it (like `throw`). */
  | { t: "break" }
  /** Skip to the next iteration of the nearest enclosing loop (`continue`).
   *  Terminal in its block, like `break`. */
  | { t: "continue" }
  /** A no-op (`pass`). Carries no dataflow or control effect; it exists only so an
   *  otherwise-empty block is syntactically valid. Dropped at lowering (no IR
   *  node); an empty block re-emits `pass` on the way out. */
  | { t: "pass" }
  /** Yield a value from a generator (`yield value`), or delegate to another
   *  iterable (`yield from value`, `delegate` true). A bare `yield` has no value.
   *  Unlike `return`, a yield SUSPENDS and resumes — control continues after it.
   *  A function containing any yield is a generator (`function*` in TS). */
  | { t: "yield"; value?: Expr; delegate?: boolean }
);

/**
 * A parameter default — a literal or a bare name reference, the subset the IR
 * carries (see `ParamDefault` in ir/schema.ts). A subtype of `Expr`, so the
 * emitters render it with their existing `expr()`.
 */
export type DefaultValue =
  | { t: "lit"; value: string | number | boolean | null }
  | { t: "var"; name: string }
  | { t: "raw"; src: string };

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
  /** A Python positional-only parameter (declared before `/`). */
  positionalOnly?: boolean;
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
  /** When true, the function is `async` (Python `async def` / TS `async function`),
   *  enabling `await` in its body. */
  async?: boolean;
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

/** A module-level constant: a bound name + its VERBATIM value source text
 *  (e.g. `HOOKS` / `["response"]`). Re-declared at module scope on emit. */
export interface Const {
  name: string;
  value: string;
  span?: SourceSpan;
}

export interface Program {
  functions: Fn[];
  classes: Class[];
  /** Imports in source order. Optional for back-compat with older callers. */
  imports?: Import[];
  /** Module-level constants in source order. */
  consts?: Const[];
}
