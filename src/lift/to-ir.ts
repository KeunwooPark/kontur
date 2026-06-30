/**
 * Lift the neutral AST (ast.ts) into a Kontur IR `System`. The inverse of
 * compile.ts: where compile walks the graph to produce statements, this walks
 * statements to produce the graph.
 *
 * Scope is "example level" — exactly the shapes our transpiler emits:
 *   functions, params/return, counted for-loops, nested if/else, the op
 *   vocabulary, print effects, and calls (to sibling modules or stubs).
 *
 * Key fidelity choices that make round-tripping exact:
 *   - A sequenced `let x = call(...)` uses `x` as the NODE ID, so re-transpiling
 *     reproduces the original variable name (compile names locals after node id).
 *   - Pure sub-expressions (consts, ops) become un-sequenced nodes, so they get
 *     inlined again on the way back out — never spuriously bound to a variable.
 */
import type { Class, Expr, Fn, Program, Stmt } from "../transpile/ast.js";
import type { Import, Module, Node, Port, SourceSpan, System, Wire } from "../ir/schema.js";

/**
 * Where a locally-imported name resolves to in the merged System. A `named`
 * import (`import { foo } from "./util"`) binds straight to that function's
 * qualified module id; a `namespace` import (`import * as util from "./util"`)
 * binds the whole file, so a `util.foo()` call qualifies the member at use site.
 */
export type LocalImportTarget =
  | { kind: "function"; id: string }
  | { kind: "namespace"; moduleKey: string };

/**
 * Optional context supplied by the multi-file project driver. Absent for the
 * single-file `liftTypeScript`/`liftPython` entry points, where ids stay bare,
 * no `origin` is recorded, and every import is treated as external — i.e. the
 * lift is byte-for-byte what it was before multi-file support.
 */
export interface LiftContext {
  /** Project-relative source path, stamped onto every module + import. */
  origin?: string;
  /** Path-without-extension used to qualify ids (`${moduleKey}#${name}`). Absent ⇒ bare ids. */
  moduleKey?: string;
  /** Local-binding name → the in-project module it resolves to (turns cross-file calls into links). */
  localImports?: Map<string, LocalImportTarget>;
  /**
   * Local-binding name → the third-party package it came from, for the bindings
   * the driver has classified as EXTERNAL (so their calls are tagged `source`).
   * Supplying this hands import classification to the driver, which knows the
   * filesystem: a relative import that resolves to a local file we couldn't lift
   * is then neither a link nor a package — it degrades to a plain stub. Absent
   * (single-file lift) ⇒ every imported name is treated as external, as before.
   */
  externalImports?: Map<string, string>;
  /**
   * Qualified module id → its parameter names, for EVERY module in the project.
   * A link's argument wires are keyed by the callee's port names, so a cross-file
   * call needs the target file's params — which this file's own scan can't see.
   * The driver supplies the whole-project map; merged with this file's functions.
   */
  moduleParams?: Map<string, string[]>;
}

interface Ctx {
  nodes: Node[];
  wires: Wire[];
  /** variable / param name → the data-source endpoint that produces it. */
  varMap: Map<string, string>;
  used: Set<string>;
  knownFns: Set<string>;
  /** qualified module id → its param names (whole project), for wiring link args. */
  moduleParams: Map<string, string[]>;
  /** imported local name → the package it came from (for tagging external calls). */
  importSource: Map<string, string>;
  /** local-binding name → in-project module it resolves to (for cross-file links). */
  localImports: Map<string, LocalImportTarget>;
  /** simple name → fully-qualified module id (identity when ids are bare). */
  qualify: (name: string) => string;
  counter: { n: number };
  returnSource: string | undefined;
}

export function liftProgram(program: Program, lift: LiftContext = {}): System {
  const knownFns = new Set(program.functions.map((f) => f.name));
  const localImports = lift.localImports ?? new Map<string, LocalImportTarget>();
  // Qualify ids by source path so two files can each define `helper` without
  // colliding. Identity when no moduleKey is given (single-file / hand-authored).
  const qualify = (name: string): string => (lift.moduleKey ? `${lift.moduleKey}#${name}` : name);
  // Param names keyed by qualified id: start from the project-wide map (so links
  // into other files wire correctly) and add this file's own functions.
  const moduleParams = new Map(lift.moduleParams ?? []);
  for (const f of program.functions) moduleParams.set(qualify(f.name), f.params.map((p) => p.name));
  // Map every imported local name to the package it crosses into, so a call
  // through that name is tagged `source`. When the driver has classified imports
  // (it knows the filesystem), use its external map verbatim; otherwise — a
  // single-file lift — treat every imported name as external, as before.
  const importSource = new Map<string, string>();
  if (lift.externalImports) {
    for (const [local, source] of lift.externalImports) importSource.set(local, source);
  } else {
    for (const imp of program.imports ?? []) {
      for (const b of imp.bindings) {
        if (!localImports.has(b.local)) importSource.set(b.local, imp.source);
      }
    }
  }
  const shared = { knownFns, moduleParams, importSource, localImports, qualify };
  const modules: Record<string, Module> = {};
  for (const fn of program.functions) modules[qualify(fn.name)] = lowerFn(fn, shared, lift.origin);
  for (const cls of program.classes) lowerClass(cls, modules, shared, lift.origin);
  // Entry-point canvases: the top-level declarations (free functions + classes),
  // never the methods — those are reached by descending into the class.
  const features = [
    ...program.functions.map((f) => qualify(f.name)),
    ...program.classes.map((c) => qualify(c.name)),
  ];
  const system: System = { features, modules };
  // Record imports verbatim so the transpiler can reproduce them (round-trip
  // fidelity). Mapped span → prov to match the IR's provenance field name.
  if (program.imports && program.imports.length > 0) {
    system.imports = program.imports.map(
      (imp): Import => ({
        source: imp.source,
        bindings: imp.bindings,
        ...(imp.span ? { prov: imp.span } : {}),
        ...(lift.origin ? { origin: lift.origin } : {}),
      }),
    );
  }
  return system;
}

/** The shared, file-wide resolution state passed to every lowering helper. */
type Shared = Pick<Ctx, "knownFns" | "moduleParams" | "importSource" | "localImports" | "qualify">;

/** The package a call name crosses into, or undefined for a local/builtin call.
 *  The base identifier (`name` before any `.`) is what an import binds. */
function externalSource(ctx: Ctx, name: string): string | undefined {
  return ctx.importSource.get(name.split(".")[0]!);
}

/**
 * A class becomes a module of kind "class": a namespace canvas whose interior is
 * a `state` cell per attribute and a `module`-link per method. Each method is a
 * function module keyed `${ClassName}.${methodName}`, reached by descending the
 * link — exactly the manifesto's hyperlink-navigation model.
 */
function lowerClass(
  cls: Class,
  modules: Record<string, Module>,
  shared: Shared,
  origin: string | undefined,
): void {
  const nodes: Node[] = [];
  for (const field of cls.fields) {
    nodes.push({ id: field.name, kind: "state", label: field.name, type: field.type });
  }
  // A method id is the class id plus `.method`; the class id itself is qualified
  // by source path so methods of same-named classes in different files stay distinct.
  const classId = shared.qualify(cls.name);
  for (const m of cls.methods) {
    const methodId = `${classId}.${m.name}`;
    modules[methodId] = lowerFn(m, shared, origin);
    nodes.push({ id: methodId, kind: "module", ref: methodId });
  }
  modules[classId] = {
    title: cls.name,
    kind: "class",
    ports: [],
    interior: { nodes, wires: [] },
    ...(cls.span ? { prov: cls.span } : {}),
    ...(origin ? { origin } : {}),
  };
}

function lowerFn(fn: Fn, shared: Shared, origin: string | undefined): Module {
  fn = normalizeReturns(fn);
  fn = { ...fn, body: foldGuards(fn.body) };
  assertSupported(fn);
  const ctx: Ctx = {
    nodes: [], wires: [], varMap: new Map(), used: new Set(),
    ...shared, counter: { n: 0 }, returnSource: undefined,
  };

  const ports: Port[] = [{ name: "exec", type: "exec", io: "in", wire: "control" }];
  for (const p of fn.params) {
    ports.push({ name: p.name, type: p.type, io: "in", wire: "data" });
    ctx.varMap.set(p.name, `P:${p.name}`);
  }

  const open = lowerBlock(ctx, fn.body, "P:exec");

  if (fn.returns.length >= 1 && ctx.returnSource !== undefined) {
    const r = fn.returns[0]!;
    ports.push({ name: r.name, type: r.type, io: "out", wire: "data" });
    ctx.wires.push([ctx.returnSource, `P:${r.name}`, "data"]);
  }
  if (open !== null) {
    ports.push({ name: "done", type: "exec", io: "out", wire: "control" });
    ctx.wires.push([open, "P:done", "control"]);
  }

  return {
    title: fn.name,
    ports,
    interior: { nodes: ctx.nodes, wires: ctx.wires },
    ...(fn.span ? { prov: fn.span } : {}),
    ...(origin ? { origin } : {}),
  };
}

/** Lower a statement list, threading control from `entryFrom`. Returns the open
 *  control endpoint at the end, or null if the block dead-ends (terminal branch). */
function lowerBlock(ctx: Ctx, stmts: Stmt[], entryFrom: string): string | null {
  let prev: string | null = entryFrom;
  for (const s of stmts) {
    if (prev === null) break; // statements after a terminal branch are unreachable
    prev = lowerStmt(ctx, s, prev);
  }
  return prev;
}

function lowerStmt(ctx: Ctx, s: Stmt, prev: string): string | null {
  switch (s.t) {
    case "print": {
      const id = newNode(ctx, { kind: "effect", label: "print", io: "out", op: "print" }, undefined, s.span);
      ctx.wires.push([lowerExpr(ctx, s.arg), `${id}:value`, "data"]);
      ctx.wires.push([prev, id, "control"]);
      return id;
    }
    case "stateSet": {
      const id = newNode(ctx, { kind: "stateSet", label: s.attr, attr: s.attr }, undefined, s.span);
      ctx.wires.push([lowerExpr(ctx, s.value), `${id}:value`, "data"]);
      ctx.wires.push([prev, id, "control"]);
      return id;
    }
    case "expr": {
      const id = lowerSequencedCall(ctx, expectCall(s.expr), undefined, s.span);
      ctx.wires.push([prev, id, "control"]);
      return id;
    }
    case "let": {
      if (s.expr.t === "call") {
        const id = lowerSequencedCall(ctx, s.expr, s.name, s.span);
        ctx.wires.push([prev, id, "control"]);
        ctx.varMap.set(s.name, id);
        return id;
      }
      // A pure value bound to a name: keep it un-sequenced so it inlines again.
      ctx.varMap.set(s.name, lowerExpr(ctx, s.expr));
      return prev;
    }
    case "if": {
      const id = newNode(ctx, { kind: "branch", label: "branch" }, undefined, s.span);
      ctx.wires.push([lowerExpr(ctx, s.cond), `${id}:cond`, "data"]);
      ctx.wires.push([prev, id, "control"]);
      lowerBlock(ctx, s.then, `${id}:then`);
      lowerBlock(ctx, s.else, `${id}:else`);
      return null; // branch arms are terminal
    }
    case "for": {
      const id = newNode(ctx, { kind: "loop", label: s.varName }, undefined, s.span);
      ctx.wires.push([lowerExpr(ctx, s.from), `${id}:from`, "data"]);
      ctx.wires.push([lowerExpr(ctx, s.to), `${id}:to`, "data"]);
      ctx.wires.push([prev, id, "control"]);
      ctx.varMap.set(s.varName, `${id}:index`);
      lowerBlock(ctx, s.body, `${id}:body`);
      return `${id}:done`;
    }
    case "while": {
      const id = newNode(ctx, { kind: "while", label: "while" }, undefined, s.span);
      ctx.wires.push([lowerExpr(ctx, s.cond), `${id}:cond`, "data"]);
      ctx.wires.push([prev, id, "control"]);
      lowerBlock(ctx, s.body, `${id}:body`);
      return `${id}:done`;
    }
    case "foreach": {
      // The collection-driven loop sibling: the iterable flows in on `iter`, the
      // bound element out on `item`. Like a counted loop's index, `item` is bound
      // BEFORE lowering the body that reads it; the iterable is evaluated in the
      // enclosing scope, so it is lowered first.
      const id = newNode(ctx, { kind: "foreach", label: s.varName }, undefined, s.span);
      ctx.wires.push([lowerExpr(ctx, s.iter), `${id}:iter`, "data"]);
      ctx.wires.push([prev, id, "control"]);
      ctx.varMap.set(s.varName, `${id}:item`);
      lowerBlock(ctx, s.body, `${id}:body`);
      return `${id}:done`;
    }
    case "try": {
      // Protected block + handler, rejoining at `done`. The catch binding (if
      // any) is a data-out `error`, bound BEFORE lowering the handler that reads
      // it — exactly like a counted loop's index. The body never sees it.
      const id = newNode(ctx, { kind: "try", label: s.catchParam ?? "" }, undefined, s.span);
      ctx.wires.push([prev, id, "control"]);
      lowerBlock(ctx, s.body, `${id}:body`);
      if (s.catchParam) ctx.varMap.set(s.catchParam, `${id}:error`);
      lowerBlock(ctx, s.handler, `${id}:catch`);
      return `${id}:done`;
    }
    case "assign": {
      // Single-assignment dataflow: a reassignment is not a node — it rebinds the
      // name to a fresh data source. The RHS is lowered against the CURRENT
      // binding first, so `n = n + 1` reads the old `n` before `n` is rebound.
      ctx.varMap.set(s.name, lowerExpr(ctx, s.expr));
      return prev;
    }
    case "throw": {
      // A terminal control node: the message flows into pin "value"; there is no
      // control-out, so the chain dead-ends here (control escapes the function) —
      // exactly like a branch arm. Returning null stops the enclosing block. A
      // typed/custom error carries its constructor name on the node's `errorType`.
      const id = newNode(ctx, { kind: "throw", label: "throw", ...(s.errorType ? { errorType: s.errorType } : {}) }, undefined, s.span);
      ctx.wires.push([lowerExpr(ctx, s.arg), `${id}:value`, "data"]);
      ctx.wires.push([prev, id, "control"]);
      return null;
    }
    case "rethrow": {
      // Terminal too — control escapes carrying the re-raised value. The only
      // difference from `throw` is that the value flows on UNWRAPPED.
      const id = newNode(ctx, { kind: "rethrow", label: "rethrow" }, undefined, s.span);
      ctx.wires.push([lowerExpr(ctx, s.value), `${id}:value`, "data"]);
      ctx.wires.push([prev, id, "control"]);
      return null;
    }
    case "return": {
      ctx.returnSource = lowerExpr(ctx, s.expr);
      return prev;
    }
    case "returnObject": {
      if (s.fields[0]) ctx.returnSource = lowerExpr(ctx, s.fields[0].expr);
      return prev;
    }
  }
}

/** A call that is sequenced on the control wire: a module link or a stub. */
function lowerSequencedCall(ctx: Ctx, e: Extract<Expr, { t: "call" }>, idHint?: string, prov?: SourceSpan): string {
  // A call to a sibling function in the same file → a link (ref qualified to match
  // the sibling's module id). An in-project imported function → a link to its file.
  const link = linkTarget(ctx, e.name);
  if (link !== undefined) {
    // Record the call-site name when it differs from the target's declared name —
    // an import alias (`f as g`) or a namespaced member call (`ns.f`) — so the
    // transpiler re-emits it to match the file's verbatim import line. A plain
    // same-name call carries no `call` (keeps the common case minimal).
    const call = e.name === bareName(link) ? {} : { call: e.name };
    const id = newNode(ctx, { kind: "module", ref: link, ...call }, idHint, prov);
    // Wire args by the CALLEE's param names (port names on its contract), looked
    // up by the resolved target id so a cross-file link wires correctly too.
    const params = ctx.moduleParams.get(link) ?? [];
    e.args.forEach((arg, i) => {
      const port = params[i] ?? `arg${i}`;
      ctx.wires.push([lowerExpr(ctx, arg), `${id}:${port}`, "data"]);
    });
    return id;
  }
  // Not a link: a local helper/stub, or — if its base name was imported — a call
  // into a package. The latter is tagged with `source` so the diagram shows the
  // trust-boundary crossing.
  const source = externalSource(ctx, e.name);
  const id = newNode(ctx, { kind: "function", label: e.name, ...(source ? { source } : {}) }, idHint, prov);
  for (const arg of e.args) ctx.wires.push([lowerExpr(ctx, arg), id, "data"]);
  return id;
}

/**
 * The qualified module id a call name links to, or undefined if it is not an
 * in-project module (a stub or a package call). Resolves, in order:
 *   - a sibling function in the same file (qualified like every local module);
 *   - a named local import (`import { foo } from "./util"` → the `foo` module);
 *   - a namespaced local import (`import * as util` + `util.foo()` → `util#foo`).
 */
function linkTarget(ctx: Ctx, name: string): string | undefined {
  if (ctx.knownFns.has(name)) return ctx.qualify(name);
  const base = name.split(".")[0]!;
  const local = ctx.localImports.get(base);
  if (!local) return undefined;
  if (local.kind === "function") return local.id;
  // namespace import: `util.member` → the `member` module in util's file.
  const member = name.slice(base.length + 1);
  return member ? `${local.moduleKey}#${member}` : undefined;
}

/** The bare local name of a (possibly path-qualified) module id: `src/util#format` → `format`. */
function bareName(id: string): string {
  const hash = id.lastIndexOf("#");
  return hash === -1 ? id : id.slice(hash + 1);
}

/** Lower a pure expression, returning the data-source endpoint that yields it. */
function lowerExpr(ctx: Ctx, e: Expr): string {
  switch (e.t) {
    case "lit":
      return newNode(ctx, { kind: "const", label: String(e.value), value: e.value });
    case "stateGet":
      return newNode(ctx, { kind: "stateGet", label: e.attr, attr: e.attr });
    case "var": {
      const ep = ctx.varMap.get(e.name);
      if (ep === undefined) throw new Error(`lift: unbound variable "${e.name}"`);
      return ep;
    }
    case "member": {
      const base = ctx.varMap.get(e.name);
      if (base === undefined) throw new Error(`lift: unbound variable "${e.name}"`);
      return `${base}:${e.member}`;
    }
    case "bin": {
      const id = newNode(ctx, { kind: "function", label: e.op, op: e.op });
      ctx.wires.push([lowerExpr(ctx, e.a), `${id}:a`, "data"]);
      ctx.wires.push([lowerExpr(ctx, e.b), `${id}:b`, "data"]);
      return id;
    }
    case "un": {
      const id = newNode(ctx, { kind: "function", label: e.op, op: e.op });
      ctx.wires.push([lowerExpr(ctx, e.x), `${id}:x`, "data"]);
      return id;
    }
    case "cond": {
      const id = newNode(ctx, { kind: "select", label: "select" });
      ctx.wires.push([lowerExpr(ctx, e.cond), `${id}:cond`, "data"]);
      ctx.wires.push([lowerExpr(ctx, e.then), `${id}:then`, "data"]);
      ctx.wires.push([lowerExpr(ctx, e.else), `${id}:else`, "data"]);
      return id;
    }
    case "array": {
      const id = newNode(ctx, { kind: "array", label: "array" });
      e.elems.forEach((el, i) => ctx.wires.push([lowerExpr(ctx, el), `${id}:${i}`, "data"]));
      return id;
    }
    case "comprehension": {
      const id = newNode(ctx, { kind: "comprehension", label: e.varName });
      ctx.wires.push([lowerExpr(ctx, e.from), `${id}:from`, "data"]);
      ctx.wires.push([lowerExpr(ctx, e.to), `${id}:to`, "data"]);
      // Bind the iteration variable BEFORE lowering the element expression, which
      // reads it — exactly like a counted loop's index.
      ctx.varMap.set(e.varName, `${id}:index`);
      ctx.wires.push([lowerExpr(ctx, e.elem), `${id}:elem`, "data"]);
      return id;
    }
    case "call": {
      // A nested call in value position → a pure (un-sequenced) stub function,
      // tagged with `source` when it calls into an imported package.
      const source = externalSource(ctx, e.name);
      const id = newNode(ctx, { kind: "function", label: e.name, ...(source ? { source } : {}) });
      for (const arg of e.args) ctx.wires.push([lowerExpr(ctx, arg), id, "data"]);
      return id;
    }
  }
}

/**
 * Rewrite a returning if/else into a single tail `return` of a `select` value,
 * so branch-arm returns become a representable data multiplexer rather than
 * multiple control exits. Only the example-level shape is converted: a *tail*
 * if/else whose every arm is itself a lone `return` (or a nested returning
 * if/else). Anything richer is left untouched for `assertSupported` to judge.
 *
 *   if (c) return A; else return B;   ⟶   return (c ? A : B);
 */
function normalizeReturns(fn: Fn): Fn {
  const last = fn.body[fn.body.length - 1];
  if (!last || last.t !== "if") return fn;
  const expr = ifReturnToExpr(last);
  if (!expr) return fn;
  return { ...fn, body: [...fn.body.slice(0, -1), { t: "return", expr }] };
}

/**
 * Fold the statements that follow a guarding branch into the branch's surviving
 * arm, so the IR's "a branch is terminal" model can represent guard clauses:
 *
 *   if (bad) { throw … }      ⟶      if (bad) { throw … } else { rest }
 *   rest
 *
 * A branch escapes control when an arm is *terminal* (ends in a `throw`, or in a
 * nested all-terminal branch). When exactly one arm escapes, the trailing
 * statements are the continuation of the OTHER arm — there is no post-branch
 * merge point in the graph, so they belong inside it. When NEITHER arm escapes
 * yet code follows the branch, that is a real merge the IR cannot express: we
 * refuse it loudly rather than silently drop the tail (manifesto: never lie).
 */
function foldGuards(stmts: Stmt[]): Stmt[] {
  const out: Stmt[] = [];
  for (let i = 0; i < stmts.length; i++) {
    const s = foldNested(stmts[i]!);
    const rest = stmts.slice(i + 1);
    if (s.t === "if" && rest.length > 0) {
      const folded = foldGuards(rest);
      const thenEscapes = isTerminal(s.then);
      const elseEscapes = isTerminal(s.else);
      if (thenEscapes && !elseEscapes) { out.push({ ...s, else: [...s.else, ...folded] }); return out; }
      if (elseEscapes && !thenEscapes) { out.push({ ...s, then: [...s.then, ...folded] }); return out; }
      if (!thenEscapes && !elseEscapes) {
        throw new Error(
          `lift: statements follow a branch whose arms both fall through — a ` +
            `control-flow merge has no IR node (only a guarding branch, where one ` +
            `arm escapes via throw, may carry a continuation)`,
        );
      }
      // both arms escape ⇒ the tail is unreachable; leave it (dropped at lowering).
    }
    out.push(s);
  }
  return out;
}

/** Recurse `foldGuards` into a statement's nested blocks. */
function foldNested(s: Stmt): Stmt {
  switch (s.t) {
    case "if": return { ...s, then: foldGuards(s.then), else: foldGuards(s.else) };
    case "for": return { ...s, body: foldGuards(s.body) };
    case "while": return { ...s, body: foldGuards(s.body) };
    case "foreach": return { ...s, body: foldGuards(s.body) };
    case "try": return { ...s, body: foldGuards(s.body), handler: foldGuards(s.handler) };
    default: return s;
  }
}

/** Does this block always escape control (never fall through to a successor)? */
function isTerminal(stmts: Stmt[]): boolean {
  const last = stmts[stmts.length - 1];
  if (!last) return false; // empty block falls through
  if (last.t === "throw" || last.t === "rethrow") return true;
  // A branch escapes only if BOTH arms do; an empty/missing else falls through.
  if (last.t === "if") return isTerminal(last.then) && isTerminal(last.else);
  return false;
}

function ifReturnToExpr(s: Stmt): Expr | null {
  if (s.t !== "if") return null;
  const then = blockReturnToExpr(s.then);
  const els = blockReturnToExpr(s.else);
  return then && els ? { t: "cond", cond: s.cond, then, else: els } : null;
}

/** A block usable as a `select` arm: a single `return E`, or a nested returning if. */
function blockReturnToExpr(block: Stmt[]): Expr | null {
  if (block.length !== 1) return null;
  const only = block[0]!;
  if (only.t === "return") return only.expr;
  if (only.t === "if") return ifReturnToExpr(only);
  return null;
}

/**
 * Reject code outside what the transpiler can faithfully represent. The IR
 * model has one boundary out-port fed by one wire, so a function may have at
 * most one `return`, and it must be the final top-level statement (no early or
 * per-branch returns — those are normalized to a `select` above when possible).
 * Better to refuse than to lift a graph that lies.
 */
function assertSupported(fn: Fn): void {
  const fail = (): never => {
    throw new Error(
      `lift: function "${fn.name}" has an early/branch return — only a single ` +
        `return as the final top-level statement is supported (example level)`,
    );
  };
  const forbidNested = (s: Stmt): void => {
    if (s.t === "return") fail();
    if (s.t === "if") { s.then.forEach(forbidNested); s.else.forEach(forbidNested); }
    if (s.t === "for") s.body.forEach(forbidNested);
    if (s.t === "while") s.body.forEach(forbidNested);
    if (s.t === "foreach") s.body.forEach(forbidNested);
    if (s.t === "try") { s.body.forEach(forbidNested); s.handler.forEach(forbidNested); }
  };
  fn.body.forEach((s, i) => {
    const isTail = i === fn.body.length - 1;
    if (s.t === "return") { if (!isTail) fail(); }
    else if (s.t === "if") { s.then.forEach(forbidNested); s.else.forEach(forbidNested); }
    else if (s.t === "for") s.body.forEach(forbidNested);
    else if (s.t === "while") s.body.forEach(forbidNested);
    else if (s.t === "foreach") s.body.forEach(forbidNested);
    else if (s.t === "try") { s.body.forEach(forbidNested); s.handler.forEach(forbidNested); }
  });
}

function expectCall(e: Expr): Extract<Expr, { t: "call" }> {
  if (e.t !== "call") throw new Error(`lift: expected a call statement, got "${e.t}"`);
  return e;
}

function newNode(
  ctx: Ctx,
  partial: Omit<Node, "id"> | Record<string, unknown>,
  idHint?: string,
  prov?: SourceSpan,
): string {
  let id = idHint ?? `_n${ctx.counter.n++}`;
  while (ctx.used.has(id)) id = `${id}_${ctx.counter.n++}`;
  ctx.used.add(id);
  ctx.nodes.push({ id, ...partial, ...(prov ? { prov } : {}) } as Node);
  return id;
}
