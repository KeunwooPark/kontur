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
import type { Expr, Fn, Program, Stmt } from "../transpile/ast.js";
import type { Module, Node, Port, System, Wire } from "../ir/schema.js";

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
  return { features: program.functions.map((f) => f.name), modules };
}

function lowerFn(fn: Fn, knownFns: Set<string>, fnParams: Map<string, string[]>): Module {
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

  return { title: fn.name, ports, interior: { nodes: ctx.nodes, wires: ctx.wires } };
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
      const id = newNode(ctx, { kind: "effect", label: "print", io: "out", op: "print" });
      ctx.wires.push([lowerExpr(ctx, s.arg), `${id}:value`, "data"]);
      ctx.wires.push([prev, id, "control"]);
      return id;
    }
    case "expr": {
      const id = lowerSequencedCall(ctx, expectCall(s.expr));
      ctx.wires.push([prev, id, "control"]);
      return id;
    }
    case "let": {
      if (s.expr.t === "call") {
        const id = lowerSequencedCall(ctx, s.expr, s.name);
        ctx.wires.push([prev, id, "control"]);
        ctx.varMap.set(s.name, id);
        return id;
      }
      // A pure value bound to a name: keep it un-sequenced so it inlines again.
      ctx.varMap.set(s.name, lowerExpr(ctx, s.expr));
      return prev;
    }
    case "if": {
      const id = newNode(ctx, { kind: "branch", label: "branch" });
      ctx.wires.push([lowerExpr(ctx, s.cond), `${id}:cond`, "data"]);
      ctx.wires.push([prev, id, "control"]);
      lowerBlock(ctx, s.then, `${id}:then`);
      lowerBlock(ctx, s.else, `${id}:else`);
      return null; // branch arms are terminal
    }
    case "for": {
      const id = newNode(ctx, { kind: "loop", label: s.varName });
      ctx.wires.push([lowerExpr(ctx, s.from), `${id}:from`, "data"]);
      ctx.wires.push([lowerExpr(ctx, s.to), `${id}:to`, "data"]);
      ctx.wires.push([prev, id, "control"]);
      ctx.varMap.set(s.varName, `${id}:index`);
      lowerBlock(ctx, s.body, `${id}:body`);
      return `${id}:done`;
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
function lowerSequencedCall(ctx: Ctx, e: Extract<Expr, { t: "call" }>, idHint?: string): string {
  if (ctx.knownFns.has(e.name)) {
    const id = newNode(ctx, { kind: "module", ref: e.name }, idHint);
    const params = ctx.fnParams.get(e.name) ?? [];
    e.args.forEach((arg, i) => {
      const port = params[i] ?? `arg${i}`;
      ctx.wires.push([lowerExpr(ctx, arg), `${id}:${port}`, "data"]);
    });
    return id;
  }
  const id = newNode(ctx, { kind: "function", label: e.name }, idHint);
  for (const arg of e.args) ctx.wires.push([lowerExpr(ctx, arg), id, "data"]);
  return id;
}

/** Lower a pure expression, returning the data-source endpoint that yields it. */
function lowerExpr(ctx: Ctx, e: Expr): string {
  switch (e.t) {
    case "lit":
      return newNode(ctx, { kind: "const", label: String(e.value), value: e.value });
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
    case "call": {
      // A nested call in value position → a pure (un-sequenced) stub function.
      const id = newNode(ctx, { kind: "function", label: e.name });
      for (const arg of e.args) ctx.wires.push([lowerExpr(ctx, arg), id, "data"]);
      return id;
    }
  }
}

/**
 * Reject code outside what the transpiler can faithfully represent. The IR
 * model has one boundary out-port fed by one wire, so a function may have at
 * most one `return`, and it must be the final top-level statement (no early or
 * per-branch returns). Better to refuse than to lift a graph that lies.
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
  };
  fn.body.forEach((s, i) => {
    const isTail = i === fn.body.length - 1;
    if (s.t === "return") { if (!isTail) fail(); }
    else if (s.t === "if") { s.then.forEach(forbidNested); s.else.forEach(forbidNested); }
    else if (s.t === "for") s.body.forEach(forbidNested);
  });
}

function expectCall(e: Expr): Extract<Expr, { t: "call" }> {
  if (e.t !== "call") throw new Error(`lift: expected a call statement, got "${e.t}"`);
  return e;
}

function newNode(ctx: Ctx, partial: Omit<Node, "id"> | Record<string, unknown>, idHint?: string): string {
  let id = idHint ?? `_n${ctx.counter.n++}`;
  while (ctx.used.has(id)) id = `${id}_${ctx.counter.n++}`;
  ctx.used.add(id);
  ctx.nodes.push({ id, ...partial } as Node);
  return id;
}
