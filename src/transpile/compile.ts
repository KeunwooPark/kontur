/**
 * Lower a validated Kontur IR `System` into the neutral AST (ast.ts).
 *
 * The model (Blueprints-style hybrid control flow):
 *   - Each module becomes a function. Data `in` ports are params; data `out`
 *     ports are the return value(s). Control ports carry execution order only.
 *   - CONTROL wires define statement order. We walk them from the module's
 *     control-in entry, recursing into branch arms and loop bodies.
 *   - DATA wires define values. A node's inputs are resolved by walking data
 *     wires backward. Pure producers (consts, op functions with no incoming
 *     control) are INLINED as expressions; sequenced nodes are referenced by
 *     the local variable they were bound to.
 *
 * The IR is assumed already validated (validateSystem). We still throw with
 * context on anything structurally impossible to lower, so bugs surface loudly.
 */
import type { Module, Node, Op, System } from "../ir/schema.js";
import { parseEndpoint } from "../ir/endpoint.js";
import type { Class as AstClass, Expr, Field, Fn, Program, Stmt } from "./ast.js";

const BINARY_OPS = new Set<Op>([
  "add", "sub", "mul", "div", "mod",
  "eq", "ne", "lt", "le", "gt", "ge",
  "is", "isnot", "in", "notin",
  "floordiv", "pow", "bitand", "bitor", "bitxor", "shl", "shr",
  "and", "or", "concat",
]);

const UNARY_OPS = new Set<Op>(["not", "neg", "pos", "bitnot"]);

/**
 * Lower a System to one neutral `Program`. With `originFilter` given, only the
 * modules + imports from that source file are emitted (the rest of the System is
 * still visible, so a cross-file link can resolve its target's contract); this is
 * how `transpileProject` regenerates one file at a time. Without it, the whole
 * System is emitted as a single file — the single-file / back-compat path.
 */
export function compile(system: System, originFilter?: string): Program {
  const inFile = (mod: Module): boolean => originFilter === undefined || (mod.origin ?? "") === originFilter;

  // A class module's `module`-link nodes are its methods; those method modules
  // are emitted *inside* the class, never again as free functions. Map each
  // method module id → its simple method name (the id is `${classId}.${name}`).
  const methodName = new Map<string, string>();
  for (const [id, mod] of Object.entries(system.modules)) {
    if (mod.kind !== "class") continue;
    for (const node of mod.interior.nodes) {
      if (node.kind === "module") {
        const simple = node.ref.startsWith(`${id}.`) ? node.ref.slice(id.length + 1) : node.ref;
        methodName.set(node.ref, simple);
      }
    }
  }

  const classes: AstClass[] = [];
  const functions: Fn[] = [];
  for (const [id, mod] of Object.entries(system.modules)) {
    if (!inFile(mod)) continue;
    if (mod.kind === "class") {
      classes.push(compileClass(id, mod, system, methodName));
    } else if (!methodName.has(id) && mod.nestedIn === undefined) {
      const fn = new ModuleCompiler(id, mod, system).compile();
      attachNested(fn, id, system);
      functions.push(fn);
    }
    // else: a method module (emitted within its class) or a nested function
    // (emitted inside its parent's body via `attachNested`).
  }
  // Imports are reproduced verbatim from the System's fidelity record; the
  // emitters render the `import` lines (prov is editor-only, dropped here). When
  // filtering by file, only that file's own imports are emitted.
  const imports = (system.imports ?? [])
    .filter((i) => originFilter === undefined || (i.origin ?? "") === originFilter)
    .map((i) => ({ source: i.source, bindings: i.bindings }));
  // Module-level constants, reproduced verbatim and re-declared at module scope.
  const consts = (system.consts ?? [])
    .filter((c) => originFilter === undefined || (c.origin ?? "") === originFilter)
    .map((c) => ({ name: c.name, value: c.value }));
  return { functions, classes, imports, ...(consts.length ? { consts } : {}) };
}

function compileClass(
  id: string,
  mod: Module,
  system: System,
  methodName: Map<string, string>,
): AstClass {
  const fields: Field[] = mod.interior.nodes
    .filter((n): n is Extract<Node, { kind: "state" }> => n.kind === "state")
    .map((n) => ({ name: n.label, type: n.type }));
  const methods: Fn[] = mod.interior.nodes
    .filter((n): n is Extract<Node, { kind: "module" }> => n.kind === "module")
    .map((n) => {
      const methodMod = system.modules[n.ref];
      if (!methodMod) throw new Error(`class "${id}": method module "${n.ref}" not found`);
      const fn = new ModuleCompiler(n.ref, methodMod, system).compile();
      fn.name = methodName.get(n.ref) ?? n.ref;
      fn.isMethod = true;
      attachNested(fn, n.ref, system);
      return fn;
    });
  return { name: id, fields, methods, ...(mod.bases && mod.bases.length ? { bases: mod.bases } : {}), ...(mod.decorators && mod.decorators.length ? { decorators: mod.decorators } : {}), ...(mod.doc !== undefined ? { doc: mod.doc } : {}) };
}

/**
 * Re-nest any lifted nested (local) functions inside their parent Fn's body. A
 * nested module carries `nestedIn: <parentId>`; we compile each such module and
 * attach it to `fn.nested` (recursing for deeper nesting). The emitters print
 * `fn.nested` as `def`s at the top of the body. `captures` is carried through so
 * the emitter strips those synthetic in-ports from the printed signature — the
 * body reads them as closure variables again, reproducing the original source.
 */
function attachNested(fn: Fn, parentId: string, system: System): void {
  const kids: Fn[] = [];
  for (const [nid, m] of Object.entries(system.modules)) {
    if (m.nestedIn !== parentId) continue;
    const nf = new ModuleCompiler(nid, m, system).compile();
    nf.name = m.title; // the bare local name, not the `parent$name` module id
    nf.nestedIn = parentId;
    if (m.captures && m.captures.length) nf.captures = m.captures;
    attachNested(nf, nid, system);
    kids.push(nf);
  }
  if (kids.length) fn.nested = kids;
}

class ModuleCompiler {
  private readonly nodes = new Map<string, Node>();
  /** key `${nodeId}:${pin}` or `P:${port}` → the wire's `from` endpoint string. */
  private readonly dataSrc = new Map<string, string>();
  /** All data wires, for stub arg gathering and producer detection. */
  private readonly dataWires: [string, string][] = [];
  private readonly controlWires: [string, string][] = [];
  private readonly hasControlIn = new Set<string>();
  /** loop / foreach nodeId → its bound variable name (index / item). */
  private readonly loopVar = new Map<string, string>();

  constructor(
    private readonly id: string,
    private readonly mod: Module,
    private readonly system: System,
  ) {
    for (const n of mod.interior.nodes) this.nodes.set(n.id, n);
    for (const [from, to, kind] of mod.interior.wires) {
      if (kind === "data") {
        this.dataWires.push([from, to]);
        this.dataSrc.set(to, from);
      } else {
        this.controlWires.push([from, to]);
        const t = parseEndpoint(to);
        if (t.kind === "node") this.hasControlIn.add(t.nodeId);
      }
    }
  }

  compile(): Fn {
    const params = this.mod.ports
      .filter((p) => p.io === "in" && p.wire === "data")
      .map((p) => ({
        name: p.name,
        type: p.type,
        ...(p.default !== undefined ? { default: p.default } : {}),
        ...(p.variadic !== undefined ? { variadic: p.variadic } : {}),
        ...(p.keywordOnly ? { keywordOnly: true } : {}),
        ...(p.positionalOnly ? { positionalOnly: true } : {}),
      }));
    const returns = this.mod.ports
      .filter((p) => p.io === "out" && p.wire === "data")
      .map((p) => ({ name: p.name, type: p.type }));

    // Entry: follow the control wire leaving the module's control in-port.
    const entryPort = this.mod.ports.find((p) => p.io === "in" && p.wire === "control");
    const body: Stmt[] = entryPort
      ? this.flowFrom(this.controlTargetFrom(`P:${entryPort.name}`))
      : [];

    // Returns are explicit terminal `return` nodes (multi-exit), so the body the
    // control walk produced already carries them. Only append a tail return when
    // the body falls through (no terminal return/escape on the last path) yet the
    // function still declares an out-port — the legacy single-capture / multi-output
    // shape where the value reaches the boundary without a dedicated return node.
    if (returns.length >= 1 && !endsTerminal(body)) {
      if (returns.length === 1) {
        body.push({ t: "return", expr: this.resolveBoundaryOut(returns[0]!.name) });
      } else {
        body.push({
          t: "returnObject",
          fields: returns.map((r) => ({ name: r.name, expr: this.resolveBoundaryOut(r.name) })),
        });
      }
    }

    // Emit under the module's bare local name: the project driver qualifies ids
    // by path (`src/util#format`), but the function declaration uses the bare
    // name. For single-file lifts the id is already bare, so this is the id.
    return { name: localName(this.id), params, returns, body, ...(this.mod.async ? { async: true } : {}), ...(this.mod.decorators && this.mod.decorators.length ? { decorators: this.mod.decorators } : {}), ...(this.mod.doc !== undefined ? { doc: this.mod.doc } : {}) };
  }

  /** Walk the control chain from `target`, returning statements. A thin wrapper
   *  over `walk` for callers that never rejoin at a merge (a function body, a
   *  loop/try/with block); a merge only surfaces to a branch's own arm walk. */
  private flowFrom(target: string | undefined): Stmt[] {
    return this.walk(target).stmts;
  }

  /** Walk the control chain from `target`, producing statements. Stops at a
   *  `merge` node (a branch's join point) WITHOUT emitting it, returning its id so
   *  the branch handler can reconstruct the phis and rejoin control afterwards. */
  private walk(target: string | undefined): { stmts: Stmt[]; merge?: string } {
    const stmts: Stmt[] = [];
    let cur = target;
    while (cur !== undefined) {
      const ep = parseEndpoint(cur);
      if (ep.kind === "boundary") break; // reached a module out-port → end of chain
      const node = this.node(ep.nodeId);

      if (node.kind === "merge") return { stmts, merge: node.id }; // a branch join point

      if (node.kind === "branch") {
        const thenArm = this.walk(this.controlTargetFrom(`${node.id}:then`));
        const elseArm = this.walk(this.controlTargetFrom(`${node.id}:else`));
        const mergeId = thenArm.merge ?? elseArm.merge;
        if (mergeId !== undefined) {
          // Reconstruct each phi as a tail assignment in its arm: `v = <arm source>`
          // (skipped when the source already IS `v` — e.g. an empty else keeping the
          // pre-branch value, whose binding is already in scope).
          const m = this.node(mergeId) as Extract<Node, { kind: "merge" }>;
          for (const v of m.phis ?? []) {
            const tExpr = this.resolveInput(mergeId, `then_${v}`);
            if (!(tExpr.t === "var" && tExpr.name === v)) thenArm.stmts.push({ t: "assign", name: v, expr: tExpr });
            const eExpr = this.resolveInput(mergeId, `else_${v}`);
            if (!(eExpr.t === "var" && eExpr.name === v)) elseArm.stmts.push({ t: "assign", name: v, expr: eExpr });
          }
        }
        stmts.push({ t: "if", cond: this.resolveInput(node.id, "cond"), then: thenArm.stmts, else: elseArm.stmts });
        if (mergeId === undefined) return { stmts }; // arms terminal — nothing follows
        cur = this.controlTargetFrom(`${mergeId}:done`); // rejoin after the merge
        continue;
      }

      if (node.kind === "loop") {
        const v = identifier(node.label) || node.id;
        this.loopVar.set(node.id, v);
        stmts.push(...this.carriedInit(node));
        stmts.push({
          t: "for",
          varName: v,
          from: this.resolveInput(node.id, "from"),
          to: this.resolveInput(node.id, "to"),
          body: [...this.flowFrom(this.controlTargetFrom(`${node.id}:body`)), ...this.carriedUpdate(node)],
        });
        cur = this.controlTargetFrom(`${node.id}:done`);
        continue;
      }

      if (node.kind === "while") {
        stmts.push(...this.carriedInit(node));
        stmts.push({
          t: "while",
          cond: this.resolveInput(node.id, "cond"),
          body: [...this.flowFrom(this.controlTargetFrom(`${node.id}:body`)), ...this.carriedUpdate(node)],
        });
        cur = this.controlTargetFrom(`${node.id}:done`);
        continue;
      }

      if (node.kind === "foreach") {
        // The item binding is resolved by the body, so register it (like a loop's
        // index) BEFORE recursing into the body. A tuple-unpack target (`names`)
        // binds per-element out-ports "0".."n-1"; a single target binds "item".
        const v = identifier(node.label) || node.id;
        this.loopVar.set(node.id, v);
        stmts.push(...this.carriedInit(node));
        stmts.push({
          t: "foreach",
          ...(node.names ? { names: node.names } : { varName: v }),
          iter: this.resolveInput(node.id, "iter"),
          body: [...this.flowFrom(this.controlTargetFrom(`${node.id}:body`)), ...this.carriedUpdate(node)],
        });
        cur = this.controlTargetFrom(`${node.id}:done`);
        continue;
      }

      if (node.kind === "try") {
        // `label` carries the catch binding name (empty ⇒ no bound variable);
        // `errorTypes` the typed-except type(s); the optional else/finally blocks
        // are present only when wired.
        const v = identifier(node.label);
        const elseTarget = this.controlTargetFrom(`${node.id}:else`);
        const finallyTarget = this.controlTargetFrom(`${node.id}:finally`);
        const body = this.flowFrom(this.controlTargetFrom(`${node.id}:body`));
        const handler = this.flowFrom(this.controlTargetFrom(`${node.id}:catch`));
        const orelse = elseTarget !== undefined ? this.flowFrom(elseTarget) : undefined;
        // A value merge across the try's paths: reconstruct each phi as a tail
        // assignment `p = <path source>` on the no-raise arm (else if present, else
        // body) and the handler arm — skipped when the source already is `p`.
        for (const p of node.phis ?? []) {
          const nrExpr = this.resolveInput(node.id, `noRaise_${p}`);
          const nrArm = orelse ?? body;
          if (!(nrExpr.t === "var" && nrExpr.name === p)) nrArm.push({ t: "assign", name: p, expr: nrExpr });
          const cExpr = this.resolveInput(node.id, `catch_${p}`);
          if (!(cExpr.t === "var" && cExpr.name === p)) handler.push({ t: "assign", name: p, expr: cExpr });
        }
        stmts.push({
          t: "try",
          body,
          ...(v ? { catchParam: v } : {}),
          ...(node.errorTypes ? { errorTypes: node.errorTypes } : {}),
          handler,
          ...(orelse !== undefined ? { orelse } : {}),
          ...(finallyTarget !== undefined ? { finalbody: this.flowFrom(finallyTarget) } : {}),
        });
        cur = this.controlTargetFrom(`${node.id}:done`);
        continue;
      }

      if (node.kind === "with") {
        // `label` carries the `as` resource binding (empty ⇒ no `as` clause).
        const v = identifier(node.label);
        stmts.push({
          t: "with",
          context: this.resolveInput(node.id, "context"),
          ...(v ? { resource: v } : {}),
          body: this.flowFrom(this.controlTargetFrom(`${node.id}:body`)),
        });
        cur = this.controlTargetFrom(`${node.id}:done`);
        continue;
      }

      if (node.kind === "assert") {
        stmts.push({
          t: "assert",
          cond: this.resolveInput(node.id, "cond"),
          ...(this.dataSrc.has(`${node.id}:message`) ? { message: this.resolveInput(node.id, "message") } : {}),
        });
        cur = this.controlNext(node.id);
        continue;
      }

      if (node.kind === "throw") {
        // Terminal: control escapes here, so the chain stops — like a branch arm.
        // `errorType` (if any) carries the typed/custom error constructor forward.
        stmts.push({
          t: "throw",
          arg: this.resolveInput(node.id, "value"),
          ...(node.errorType ? { errorType: node.errorType } : {}),
        });
        return { stmts };
      }

      if (node.kind === "rethrow") {
        // Terminal too; the value is re-raised unwrapped (`throw e` / `raise e`).
        // A bare `raise` (no "value" wire) re-raises the active exception.
        stmts.push(this.dataSrc.has(`${node.id}:value`)
          ? { t: "rethrow", value: this.resolveInput(node.id, "value") }
          : { t: "rethrow" });
        return { stmts };
      }

      if (node.kind === "break" || node.kind === "continue") {
        // Terminal loop escape: the chain dead-ends here, like a branch arm.
        stmts.push({ t: node.kind });
        return { stmts };
      }

      if (node.kind === "return") {
        // Terminal: a function exit. A value return carries its "value" data-in; a
        // bare (void) return has no value wire. The chain dead-ends here.
        const hasValue = this.dataSrc.has(`${node.id}:value`);
        stmts.push(hasValue ? { t: "return", expr: this.resolveInput(node.id, "value") } : { t: "return" });
        return { stmts };
      }

      if (node.kind === "yield") {
        // Sequenced (not terminal): a yield suspends then resumes.
        stmts.push({
          t: "yield",
          ...(this.dataSrc.has(`${node.id}:value`) ? { value: this.resolveInput(node.id, "value") } : {}),
          ...(node.delegate ? { delegate: true } : {}),
        });
        cur = this.controlNext(node.id);
        continue;
      }

      if (node.kind === "stateSet") {
        stmts.push({ t: "stateSet", attr: node.attr, value: this.resolveInput(node.id, "value") });
        cur = this.controlNext(node.id);
        continue;
      }

      if (node.kind === "attrSet") {
        stmts.push({
          t: "attrSet",
          obj: this.resolveInput(node.id, "obj"),
          attr: node.attr,
          value: this.resolveInput(node.id, "value"),
        });
        cur = this.controlNext(node.id);
        continue;
      }

      if (node.kind === "indexSet") {
        stmts.push({
          t: "indexSet",
          obj: this.resolveInput(node.id, "obj"),
          key: this.resolveInput(node.id, "key"),
          value: this.resolveInput(node.id, "value"),
        });
        cur = this.controlNext(node.id);
        continue;
      }

      if (node.kind === "delIndex") {
        stmts.push({ t: "delIndex", obj: this.resolveInput(node.id, "obj"), key: this.resolveInput(node.id, "key") });
        cur = this.controlNext(node.id);
        continue;
      }

      if (node.kind === "delAttr") {
        stmts.push({ t: "delAttr", obj: this.resolveInput(node.id, "obj"), attr: node.attr });
        cur = this.controlNext(node.id);
        continue;
      }

      if (node.kind === "broadcast") {
        // Chained assignment: the value (resolved once) bound to every name.
        stmts.push({ t: "chain", names: node.names, value: this.resolveInput(node.id, "value") });
        cur = this.controlNext(node.id);
        continue;
      }

      if (node.kind === "unpack") {
        // Sequence unpacking: the value (resolved once) destructured into the
        // bound names; each out-port read resolves back to its name in resolveSrc.
        stmts.push({ t: "destructure", names: node.names, value: this.resolveInput(node.id, "value") });
        cur = this.controlNext(node.id);
        continue;
      }

      if (node.kind === "effect") {
        if (node.op === "print") {
          stmts.push({ t: "print", arg: this.resolveInput(node.id, "value") });
        } else {
          const call: Expr = { t: "call", name: node.label, args: this.stubArgs(node.id) };
          // An effect can also yield a value (e.g. a DB read) — bind it if used.
          if (this.producesData(node.id)) stmts.push({ t: "let", name: node.id, expr: call });
          else stmts.push({ t: "expr", expr: call });
        }
      } else if (node.kind === "function" || node.kind === "module" || node.kind === "method") {
        // A captured local a nested function reads is bound in the parent just
        // before the call (it is not passed as an arg — the closure reads it), so
        // its defining value survives even though the call site drops the arg.
        if (node.kind === "module") stmts.push(...this.captureInits(node));
        const expr =
          node.kind === "module" ? this.moduleCall(node)
          : node.kind === "method" ? this.methodCall(node)
          : this.exprFor(node);
        if (this.producesData(node.id)) stmts.push({ t: "let", name: node.id, expr });
        else stmts.push({ t: "expr", expr });
      } else {
        throw new Error(`node "${node.id}" (kind ${node.kind}) cannot be control-sequenced`);
      }

      cur = this.controlNext(node.id);
    }
    return { stmts };
  }

  /** Inline expression for a pure producer node (const / op function / stub). */
  private exprFor(node: Node): Expr {
    switch (node.kind) {
      case "const":
        return { t: "lit", value: node.value };
      case "stateGet":
        return { t: "stateGet", attr: node.attr };
      case "attrGet":
        return { t: "attr", obj: this.resolveInput(node.id, "obj"), name: node.attr };
      case "method":
        return this.methodCall(node);
      case "select":
        return {
          t: "cond",
          cond: this.resolveInput(node.id, "cond"),
          then: this.resolveInput(node.id, "then"),
          else: this.resolveInput(node.id, "else"),
        };
      case "array": {
        const elems: Expr[] = [];
        for (let i = 0; this.dataSrc.has(`${node.id}:${i}`); i++) {
          elems.push(this.resolveInput(node.id, String(i)));
        }
        return { t: "array", elems };
      }
      case "collection": {
        if (node.form === "dict") {
          const entries: { key: Expr; value: Expr }[] = [];
          for (let i = 0; this.dataSrc.has(`${node.id}:key${i}`); i++) {
            entries.push({ key: this.resolveInput(node.id, `key${i}`), value: this.resolveInput(node.id, `val${i}`) });
          }
          return { t: "collection", form: "dict", entries };
        }
        const elems: Expr[] = [];
        for (let i = 0; this.dataSrc.has(`${node.id}:${i}`); i++) {
          elems.push(this.resolveInput(node.id, String(i)));
        }
        return { t: "collection", form: node.form, elems };
      }
      case "index":
        return { t: "index", obj: this.resolveInput(node.id, "obj"), key: this.resolveInput(node.id, "key") };
      case "await":
        return { t: "await", value: this.resolveInput(node.id, "x") };
      case "globalRef":
        return { t: "global", name: node.label };
      case "selfRef":
        return { t: "self" };
      case "slice": {
        // Each bound is present only when its pin is wired (an absent bound is an
        // open slice end, `obj[:3]` / `obj[1:]`).
        const bound = (pin: "start" | "stop" | "step") =>
          this.dataSrc.has(`${node.id}:${pin}`) ? { [pin]: this.resolveInput(node.id, pin) } : {};
        return { t: "slice", obj: this.resolveInput(node.id, "obj"), ...bound("start"), ...bound("stop"), ...bound("step") };
      }
      case "comprehension":
        return {
          t: "comprehension",
          varName: identifier(node.label) || node.id,
          from: this.resolveInput(node.id, "from"),
          to: this.resolveInput(node.id, "to"),
          elem: this.resolveInput(node.id, "elem"),
        };
      case "itercomp": {
        // A tuple-unpack target reconstructs `varNames`; a single target `varName`.
        const target = node.names ? { varNames: node.names } : { varName: identifier(node.label) || node.id };
        const iter = this.resolveInput(node.id, "iter");
        const cond = this.dataSrc.has(`${node.id}:cond`)
          ? { cond: this.resolveInput(node.id, "cond") }
          : {};
        if (node.form === "dict") {
          return { t: "itercomp", form: "dict", ...target, iter, key: this.resolveInput(node.id, "key"), value: this.resolveInput(node.id, "value"), ...cond };
        }
        return { t: "itercomp", form: node.form, ...target, iter, elem: this.resolveInput(node.id, "elem"), ...cond };
      }
      case "function": {
        if (node.op && BINARY_OPS.has(node.op)) {
          return { t: "bin", op: node.op, a: this.resolveInput(node.id, "a"), b: this.resolveInput(node.id, "b") };
        }
        if (node.op && UNARY_OPS.has(node.op)) {
          return { t: "un", op: node.op, x: this.resolveInput(node.id, "x") };
        }
        // An external (package) call emits its API name verbatim. A stub whose `ref`
        // resolves to a CLASS is a value-position constructor (`[Box(n)]`): emit the
        // class name verbatim too, so its PascalCase survives (not snake-cased to `box`).
        const verbatim = node.source !== undefined || (node.ref !== undefined && this.system.modules[node.ref]?.kind === "class");
        return { t: "call", name: node.label, ...this.callArgs(node), ...(verbatim ? { external: true } : {}) };
      }
      default:
        throw new Error(`node "${node.id}" (kind ${node.kind}) is not an inlinable value`);
    }
  }

  private moduleCall(node: Extract<Node, { kind: "module" }>): Expr {
    const target = this.system.modules[node.ref]!;
    // A captured closure variable is an in-port for dataflow, but it is NOT passed
    // at the call site (the re-nested body reads it as a closure var) — so drop
    // those args, mirroring how the emitter strips them from the signature.
    const captures = new Set(target.captures ?? []);
    // Emit an argument for each in-data port that is actually wired. A port left
    // unwired at the call site (an argument relying on the callee's default, or a
    // partial link formed under the tolerant lift) is skipped rather than crashing
    // the compile — keeping the reverse (transpile) robust.
    const args = target.ports
      .filter((p) => p.io === "in" && p.wire === "data" && !captures.has(p.name) && this.dataSrc.has(`${node.id}:${p.name}`))
      .map((p) => this.resolveInput(node.id, p.name));
    // A nested (local) function is called by its bare name, never the `parent$name`
    // module id that `localName(node.ref)` would yield.
    if (target.nestedIn !== undefined && !node.call) return { t: "call", name: target.title, args };
    // A CONSTRUCTOR call links to a `class` module: emit the class name VERBATIM
    // (external ⇒ no snake/camel re-casing), so `Session(...)` / `models.Request(...)`
    // round-trips with its PascalCase intact.
    if (target.kind === "class") return { t: "call", name: node.call ?? target.title, args, external: true };
    // Call by the call-site name (`call`) when set — an import alias or a
    // `ns.member` access — else the target's bare local name. `call` is the exact
    // source text, so emit it VERBATIM (like a package call): re-casing would
    // mangle a snake_case alias or a dotted `ns.member` and break the match with
    // the file's verbatim import line. A bare same-file name is cased normally.
    if (node.call) return { t: "call", name: node.call, args, external: true };
    return { t: "call", name: localName(node.ref), args };
  }

  /** Bindings for a nested function's captured locals, emitted in the PARENT just
   *  before the call. A capture is not passed as an argument (the re-nested body
   *  reads it as a closure variable), so the parent must still bind its value — the
   *  value flows into the capture in-port from the parent's own dataflow. A capture
   *  that is already the same-named variable in scope (a parameter) needs no
   *  re-binding, exactly like a loop-carried self-assign. */
  private captureInits(node: Extract<Node, { kind: "module" }>): Stmt[] {
    const target = this.system.modules[node.ref];
    if (!target?.captures?.length) return [];
    const out: Stmt[] = [];
    for (const cap of target.captures) {
      if (!this.dataSrc.has(`${node.id}:${cap}`)) continue;
      const expr = this.resolveInput(node.id, cap);
      if (expr.t === "var" && expr.name === cap) continue; // already in scope
      out.push({ t: "let", name: cap, expr });
    }
    return out;
  }

  /** Loop-carried accumulator init, emitted BEFORE the loop: `v = <in_v source>`
   *  (e.g. `total = 0`). A redundant `v = v` (the value already lives in `v`, e.g.
   *  a carried param) is dropped — the binding is already in scope. */
  private carriedInit(node: Extract<Node, { kind: "loop" | "while" | "foreach" }>): Stmt[] {
    const out: Stmt[] = [];
    for (const v of node.carried ?? []) {
      const expr = this.resolveInput(node.id, `in_${v}`);
      if (expr.t === "var" && expr.name === v) continue;
      out.push({ t: "let", name: v, expr, mutable: true }); // reassigned in the loop
    }
    return out;
  }

  /** Loop-carried accumulator update, appended to the loop body: `v = <next_v
   *  source>` (e.g. `total = (total + x)`). A redundant `v = v` is dropped — a
   *  CONDITIONAL accumulator already reassigns `v` inside the body (via a branch
   *  merge), so its `next_v` is just `v` and needs no trailing self-assign. */
  private carriedUpdate(node: Extract<Node, { kind: "loop" | "while" | "foreach" }>): Stmt[] {
    const out: Stmt[] = [];
    for (const v of node.carried ?? []) {
      const expr = this.resolveInput(node.id, `next_${v}`);
      if (expr.t === "var" && expr.name === v) continue;
      out.push({ t: "assign", name: v, expr });
    }
    return out;
  }

  /** A stub/method node's positional args: data wires into its BARE endpoint, in
   *  wire order (named pins — recv, star*, kw* — are excluded by the exact match). */
  private stubArgs(nodeId: string): Expr[] {
    return this.dataWires
      .filter(([, to]) => to === nodeId)
      .map(([from]) => this.resolveSrc(from));
  }

  /** Reconstruct a call's full arg structure from a node: positional (bare), `*x`
   *  unpacks ("star0".. via starCount), and keyword/`**` args ("kw0".. via kwNames). */
  private callArgs(node: Extract<Node, { kind: "function" | "method" }>): Pick<Extract<Expr, { t: "call" }>, "args" | "starArgs" | "kwargs"> {
    const out: Pick<Extract<Expr, { t: "call" }>, "args" | "starArgs" | "kwargs"> = { args: this.stubArgs(node.id) };
    if (node.starCount) out.starArgs = Array.from({ length: node.starCount }, (_, i) => this.resolveInput(node.id, `star${i}`));
    if (node.kwNames) out.kwargs = node.kwNames.map((name, i) => ({ name, value: this.resolveInput(node.id, `kw${i}`) }));
    return out;
  }

  /** Reconstruct a method call from a `method` node: the receiver is the wired
   *  "recv" pin, or the ambient `self`/`this` when no such wire exists; the args
   *  are the positional (bare-endpoint) wires, in order. */
  private methodCall(node: Extract<Node, { kind: "method" }>): Expr {
    const recv: Expr = this.dataSrc.has(`${node.id}:recv`)
      ? this.resolveInput(node.id, "recv")
      : { t: "self" };
    return { t: "call", name: node.label, ...this.callArgs(node), recv };
  }

  /** Resolve a named input pin of a node to an expression. */
  private resolveInput(nodeId: string, pin: string): Expr {
    const src = this.dataSrc.get(`${nodeId}:${pin}`);
    if (src === undefined) {
      throw new Error(`module "${this.id}": node "${nodeId}" has no data wire into pin "${pin}"`);
    }
    return this.resolveSrc(src);
  }

  private resolveBoundaryOut(port: string): Expr {
    const src = this.dataSrc.get(`P:${port}`);
    if (src === undefined) {
      throw new Error(`module "${this.id}": out-port "${port}" has no data wire feeding it`);
    }
    return this.resolveSrc(src);
  }

  /** Turn a wire's `from` endpoint into an expression. */
  private resolveSrc(from: string): Expr {
    const ep = parseEndpoint(from);
    if (ep.kind === "boundary") return { t: "var", name: ep.port }; // a module in-port → param

    const src = this.node(ep.nodeId);
    // A merge (branch join) out-port is the phi variable itself — the arms bind it,
    // downstream reads it by name.
    if (src.kind === "merge" && ep.port !== undefined) {
      return { t: "var", name: ep.port };
    }
    // A loop-carried accumulator's value, read in the body ("carry_v") or after the
    // loop ("out_v"), is just the variable `v` — the loop node's iter-args carry it.
    if ((src.kind === "loop" || src.kind === "foreach" || src.kind === "while") && ep.port !== undefined) {
      if (ep.port.startsWith("carry_")) return { t: "var", name: ep.port.slice(6) };
      if (ep.port.startsWith("out_")) return { t: "var", name: ep.port.slice(4) };
    }
    if (src.kind === "loop" && ep.port === "index") {
      return { t: "var", name: this.loopVar.get(src.id) ?? src.id };
    }
    // A comprehension's bound variable, read by its element expression.
    if (src.kind === "comprehension" && ep.port === "index") {
      return { t: "var", name: identifier(src.label) || src.id };
    }
    // An iterable comprehension's bound element, read by elem/key/value/cond. A
    // tuple-unpack target reads element ports "0".."n-1"; a single target "item".
    if (src.kind === "itercomp" && ep.port === "item") {
      return { t: "var", name: identifier(src.label) || src.id };
    }
    if (src.kind === "itercomp" && src.names && ep.port !== undefined) {
      return { t: "var", name: src.names[Number(ep.port)] ?? src.id };
    }
    // A foreach's bound element, read inside its body. Single target → "item";
    // tuple-unpack → element ports "0".."n-1" mapped to each unpacked name.
    if (src.kind === "foreach" && ep.port === "item") {
      return { t: "var", name: this.loopVar.get(src.id) ?? src.id };
    }
    if (src.kind === "foreach" && src.names && ep.port !== undefined) {
      return { t: "var", name: src.names[Number(ep.port)] ?? src.id };
    }
    // A try's caught-error binding, read inside its handler.
    if (src.kind === "try" && ep.port === "error") {
      return { t: "var", name: identifier(src.label) || src.id };
    }
    // A try's value-merge out-port is the phi variable, read after the try.
    if (src.kind === "try" && ep.port !== undefined && (src.phis ?? []).includes(ep.port)) {
      return { t: "var", name: ep.port };
    }
    // A with's `as` resource binding, read inside its body.
    if (src.kind === "with" && ep.port === "resource") {
      return { t: "var", name: identifier(src.label) || src.id };
    }
    // An unpack node's element out-port "i" → the i-th destructured name.
    if (src.kind === "unpack" && ep.port !== undefined) {
      return { t: "var", name: src.names[Number(ep.port)] ?? src.id };
    }
    // A broadcast node's out-port "i" → the i-th chained name (all hold the value).
    if (src.kind === "broadcast" && ep.port !== undefined) {
      return { t: "var", name: src.names[Number(ep.port)] ?? src.id };
    }
    if (this.hasControlIn.has(src.id)) {
      // Sequenced → bound to a local variable earlier in the flow.
      if (src.kind === "module" && this.dataOutCount(src.ref) > 1 && ep.port) {
        return { t: "member", name: src.id, member: ep.port };
      }
      return { t: "var", name: src.id };
    }
    return this.exprFor(src); // pure → inline
  }

  // --- small helpers --------------------------------------------------------

  private node(id: string): Node {
    const n = this.nodes.get(id);
    if (!n) throw new Error(`module "${this.id}": unknown node "${id}"`);
    return n;
  }

  private producesData(nodeId: string): boolean {
    return this.dataWires.some(([from]) => endpointNode(from) === nodeId);
  }

  private dataOutCount(moduleId: string): number {
    const m = this.system.modules[moduleId];
    return m ? m.ports.filter((p) => p.io === "out" && p.wire === "data").length : 0;
  }

  /** The control wire target leaving a specific `from` endpoint string. */
  private controlTargetFrom(fromEndpoint: string): string | undefined {
    return this.controlWires.find(([from]) => from === fromEndpoint)?.[1];
  }

  /** The single control wire leaving a sequenced node (any out pin). */
  private controlNext(nodeId: string): string | undefined {
    return this.controlWires.find(([from]) => endpointNode(from) === nodeId)?.[1];
  }
}

/** Does this reconstructed block end in a statement that escapes control (so no
 *  tail return should be appended)? A return/throw/rethrow/break/continue, or a
 *  branch whose every arm escapes. */
function endsTerminal(stmts: Stmt[]): boolean {
  const last = stmts[stmts.length - 1];
  if (!last) return false;
  if (last.t === "return" || last.t === "returnObject" || last.t === "throw" || last.t === "rethrow" || last.t === "break" || last.t === "continue") return true;
  if (last.t === "if") return endsTerminal(last.then) && endsTerminal(last.else);
  // A with's body always runs; a try escapes only if both body and handler do.
  if (last.t === "with") return endsTerminal(last.body);
  if (last.t === "try") return endsTerminal(last.body) && endsTerminal(last.handler);
  return false;
}

/** The bare local name of a (possibly path-qualified) module id: `src/util#format` → `format`. */
function localName(id: string): string {
  const hash = id.lastIndexOf("#");
  return hash === -1 ? id : id.slice(hash + 1);
}

/** nodeId of an endpoint string, or undefined for a boundary (`P:`) endpoint. */
function endpointNode(s: string): string | undefined {
  const ep = parseEndpoint(s);
  return ep.kind === "node" ? ep.nodeId : undefined;
}

/** Best-effort identifier from a free-text label (for loop variables). */
function identifier(label: string): string {
  const cleaned = label.trim().replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : "";
}
