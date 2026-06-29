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
import type { Module, Node, Port, SourceSpan, System, Wire } from "../ir/schema.js";

interface Ctx {
  nodes: Node[];
  wires: Wire[];
  /** variable / param name → the data-source endpoint that produces it. */
  varMap: Map<string, string>;
  used: Set<string>;
  knownFns: Set<string>;
  fnParams: Map<string, string[]>;
  counter: { n: number };
  returnSource: string | undefined;
}

export function liftProgram(program: Program): System {
  const knownFns = new Set(program.functions.map((f) => f.name));
  const fnParams = new Map(program.functions.map((f) => [f.name, f.params.map((p) => p.name)]));
  const modules: Record<string, Module> = {};
  for (const fn of program.functions) modules[fn.name] = lowerFn(fn, knownFns, fnParams);
  for (const cls of program.classes) lowerClass(cls, modules, knownFns, fnParams);
  // Entry-point canvases: the top-level declarations (free functions + classes),
  // never the methods — those are reached by descending into the class.
  const features = [...program.functions.map((f) => f.name), ...program.classes.map((c) => c.name)];
  return { features, modules };
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
  knownFns: Set<string>,
  fnParams: Map<string, string[]>,
): void {
  const nodes: Node[] = [];
  for (const field of cls.fields) {
    nodes.push({ id: field.name, kind: "state", label: field.name, type: field.type });
  }
  for (const m of cls.methods) {
    const methodId = `${cls.name}.${m.name}`;
    modules[methodId] = lowerFn(m, knownFns, fnParams);
    nodes.push({ id: methodId, kind: "module", ref: methodId });
  }
  modules[cls.name] = {
    title: cls.name,
    kind: "class",
    ports: [],
    interior: { nodes, wires: [] },
    ...(cls.span ? { prov: cls.span } : {}),
  };
}

function lowerFn(fn: Fn, knownFns: Set<string>, fnParams: Map<string, string[]>): Module {
  fn = normalizeReturns(fn);
  fn = { ...fn, body: foldGuards(fn.body) };
  assertSupported(fn);
  const ctx: Ctx = {
    nodes: [], wires: [], varMap: new Map(), used: new Set(),
    knownFns, fnParams, counter: { n: 0 }, returnSource: undefined,
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

  return { title: fn.name, ports, interior: { nodes: ctx.nodes, wires: ctx.wires }, ...(fn.span ? { prov: fn.span } : {}) };
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
  if (ctx.knownFns.has(e.name)) {
    const id = newNode(ctx, { kind: "module", ref: e.name }, idHint, prov);
    const params = ctx.fnParams.get(e.name) ?? [];
    e.args.forEach((arg, i) => {
      const port = params[i] ?? `arg${i}`;
      ctx.wires.push([lowerExpr(ctx, arg), `${id}:${port}`, "data"]);
    });
    return id;
  }
  const id = newNode(ctx, { kind: "function", label: e.name }, idHint, prov);
  for (const arg of e.args) ctx.wires.push([lowerExpr(ctx, arg), id, "data"]);
  return id;
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
      // A nested call in value position → a pure (un-sequenced) stub function.
      const id = newNode(ctx, { kind: "function", label: e.name });
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
