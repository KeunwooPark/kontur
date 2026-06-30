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
  "and", "or", "concat",
]);

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
    } else if (!methodName.has(id)) {
      functions.push(new ModuleCompiler(id, mod, system).compile());
    }
    // else: a method module — emitted within its class above.
  }
  // Imports are reproduced verbatim from the System's fidelity record; the
  // emitters render the `import` lines (prov is editor-only, dropped here). When
  // filtering by file, only that file's own imports are emitted.
  const imports = (system.imports ?? [])
    .filter((i) => originFilter === undefined || (i.origin ?? "") === originFilter)
    .map((i) => ({ source: i.source, bindings: i.bindings }));
  return { functions, classes, imports };
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
      return fn;
    });
  return { name: id, fields, methods };
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
      .map((p) => ({ name: p.name, type: p.type }));
    const returns = this.mod.ports
      .filter((p) => p.io === "out" && p.wire === "data")
      .map((p) => ({ name: p.name, type: p.type }));

    // Entry: follow the control wire leaving the module's control in-port.
    const entryPort = this.mod.ports.find((p) => p.io === "in" && p.wire === "control");
    const body: Stmt[] = entryPort
      ? this.flowFrom(this.controlTargetFrom(`P:${entryPort.name}`))
      : [];

    if (returns.length === 1) {
      body.push({ t: "return", expr: this.resolveBoundaryOut(returns[0]!.name) });
    } else if (returns.length > 1) {
      body.push({
        t: "returnObject",
        fields: returns.map((r) => ({ name: r.name, expr: this.resolveBoundaryOut(r.name) })),
      });
    }

    // Emit under the module's bare local name: the project driver qualifies ids
    // by path (`src/util#format`), but the function declaration uses the bare
    // name. For single-file lifts the id is already bare, so this is the id.
    return { name: localName(this.id), params, returns, body };
  }

  /** Walk the control chain starting at `target`, producing statements. */
  private flowFrom(target: string | undefined): Stmt[] {
    const stmts: Stmt[] = [];
    let cur = target;
    while (cur !== undefined) {
      const ep = parseEndpoint(cur);
      if (ep.kind === "boundary") break; // reached a module out-port → end of chain
      const node = this.node(ep.nodeId);

      if (node.kind === "branch") {
        stmts.push({
          t: "if",
          cond: this.resolveInput(node.id, "cond"),
          then: this.flowFrom(this.controlTargetFrom(`${node.id}:then`)),
          else: this.flowFrom(this.controlTargetFrom(`${node.id}:else`)),
        });
        return stmts; // arms are terminal; nothing falls through after a branch
      }

      if (node.kind === "loop") {
        const v = identifier(node.label) || node.id;
        this.loopVar.set(node.id, v);
        stmts.push({
          t: "for",
          varName: v,
          from: this.resolveInput(node.id, "from"),
          to: this.resolveInput(node.id, "to"),
          body: this.flowFrom(this.controlTargetFrom(`${node.id}:body`)),
        });
        cur = this.controlTargetFrom(`${node.id}:done`);
        continue;
      }

      if (node.kind === "while") {
        stmts.push({
          t: "while",
          cond: this.resolveInput(node.id, "cond"),
          body: this.flowFrom(this.controlTargetFrom(`${node.id}:body`)),
        });
        cur = this.controlTargetFrom(`${node.id}:done`);
        continue;
      }

      if (node.kind === "foreach") {
        // The item binding is resolved by the body, so register it (like a loop's
        // index) BEFORE recursing into the body.
        const v = identifier(node.label) || node.id;
        this.loopVar.set(node.id, v);
        stmts.push({
          t: "foreach",
          varName: v,
          iter: this.resolveInput(node.id, "iter"),
          body: this.flowFrom(this.controlTargetFrom(`${node.id}:body`)),
        });
        cur = this.controlTargetFrom(`${node.id}:done`);
        continue;
      }

      if (node.kind === "try") {
        // `label` carries the catch binding name (empty ⇒ no bound variable).
        const v = identifier(node.label);
        stmts.push({
          t: "try",
          body: this.flowFrom(this.controlTargetFrom(`${node.id}:body`)),
          ...(v ? { catchParam: v } : {}),
          handler: this.flowFrom(this.controlTargetFrom(`${node.id}:catch`)),
        });
        cur = this.controlTargetFrom(`${node.id}:done`);
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
        return stmts;
      }

      if (node.kind === "rethrow") {
        // Terminal too; the value is re-raised unwrapped (`throw e` / `raise e`).
        stmts.push({ t: "rethrow", value: this.resolveInput(node.id, "value") });
        return stmts;
      }

      if (node.kind === "stateSet") {
        stmts.push({ t: "stateSet", attr: node.attr, value: this.resolveInput(node.id, "value") });
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
      } else if (node.kind === "function" || node.kind === "module") {
        const expr = node.kind === "module" ? this.moduleCall(node) : this.exprFor(node);
        if (this.producesData(node.id)) stmts.push({ t: "let", name: node.id, expr });
        else stmts.push({ t: "expr", expr });
      } else {
        throw new Error(`node "${node.id}" (kind ${node.kind}) cannot be control-sequenced`);
      }

      cur = this.controlNext(node.id);
    }
    return stmts;
  }

  /** Inline expression for a pure producer node (const / op function / stub). */
  private exprFor(node: Node): Expr {
    switch (node.kind) {
      case "const":
        return { t: "lit", value: node.value };
      case "stateGet":
        return { t: "stateGet", attr: node.attr };
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
      case "comprehension":
        return {
          t: "comprehension",
          varName: identifier(node.label) || node.id,
          from: this.resolveInput(node.id, "from"),
          to: this.resolveInput(node.id, "to"),
          elem: this.resolveInput(node.id, "elem"),
        };
      case "function": {
        if (node.op && BINARY_OPS.has(node.op)) {
          return { t: "bin", op: node.op, a: this.resolveInput(node.id, "a"), b: this.resolveInput(node.id, "b") };
        }
        if (node.op === "not") {
          return { t: "un", op: node.op, x: this.resolveInput(node.id, "x") };
        }
        // An external (package) call carries its source; emit its API name verbatim.
        return { t: "call", name: node.label, args: this.stubArgs(node.id), ...(node.source ? { external: true } : {}) };
      }
      default:
        throw new Error(`node "${node.id}" (kind ${node.kind}) is not an inlinable value`);
    }
  }

  private moduleCall(node: Extract<Node, { kind: "module" }>): Expr {
    const target = this.system.modules[node.ref]!;
    const args = target.ports
      .filter((p) => p.io === "in" && p.wire === "data")
      .map((p) => this.resolveInput(node.id, p.name));
    // Call by the call-site name (`call`) when set — an import alias or a
    // `ns.member` access — else the target's bare local name. `call` is the exact
    // source text, so emit it VERBATIM (like a package call): re-casing would
    // mangle a snake_case alias or a dotted `ns.member` and break the match with
    // the file's verbatim import line. A bare same-file name is cased normally.
    if (node.call) return { t: "call", name: node.call, args, external: true };
    return { t: "call", name: localName(node.ref), args };
  }

  /** Gather every data input wired into a node, in wire order (for stub calls). */
  private stubArgs(nodeId: string): Expr[] {
    return this.dataWires
      .filter(([, to]) => endpointNode(to) === nodeId)
      .map(([from]) => this.resolveSrc(from));
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
    if (src.kind === "loop" && ep.port === "index") {
      return { t: "var", name: this.loopVar.get(src.id) ?? src.id };
    }
    // A comprehension's bound variable, read by its element expression.
    if (src.kind === "comprehension" && ep.port === "index") {
      return { t: "var", name: identifier(src.label) || src.id };
    }
    // A foreach's bound element, read inside its body.
    if (src.kind === "foreach" && ep.port === "item") {
      return { t: "var", name: this.loopVar.get(src.id) ?? src.id };
    }
    // A try's caught-error binding, read inside its handler.
    if (src.kind === "try" && ep.port === "error") {
      return { t: "var", name: identifier(src.label) || src.id };
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
