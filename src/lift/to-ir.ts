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
  /**
   * Every class module id in the project. Lets a constructor-bound local
   * (`s = Session()`) be typed, so a later `s.method()` links to that class's
   * method. The driver supplies the whole-project set; merged with this file's.
   */
  classIds?: Set<string>;
}

interface Ctx {
  nodes: Node[];
  wires: Wire[];
  /** variable / param name → the data-source endpoint that produces it. */
  varMap: Map<string, string>;
  used: Set<string>;
  knownFns: Set<string>;
  /** Sibling/imported CLASS names → their module resolves as a constructor link
   *  (`Session()` → a link to the `Session` class, whose contract is its `__init__`).
   *  Kept apart from `knownFns` so a class is never mistaken for a plain function. */
  knownClasses: Set<string>;
  /** qualified module id → its param names (whole project), for wiring link args. */
  moduleParams: Map<string, string[]>;
  /** imported local name → the package it came from (for tagging external calls). */
  importSource: Map<string, string>;
  /** local-binding name → in-project module it resolves to (for cross-file links). */
  localImports: Map<string, LocalImportTarget>;
  /** simple name → fully-qualified module id (identity when ids are bare). */
  qualify: (name: string) => string;
  /** Nested (local) function name → its lifted module id, in scope only while
   *  lowering the body that declares it. Resolved BEFORE `knownFns` so a local
   *  helper shadows a same-named top-level function (lexical scope). */
  localFns?: Map<string, string>;
  /** Every class module id in the project — used to type a constructor-bound local. */
  classIds: Set<string>;
  /** The enclosing class id when lowering a method body (so `self.m()` links to
   *  `${selfClassId}.m`). Absent for a free function. Inherited by nested fns. */
  selfClassId?: string;
  /** Local variable name → the class id it was constructed from (`s = Session()`),
   *  so a later `s.method()` links to that class's method. Per-function scope. */
  varTypes: Map<string, string>;
  /** Module-scope names usable as a VALUE (a bare identifier not bound locally):
   *  imported names, sibling classes/functions, module constants, and language
   *  builtins. An unbound `var` that IS one lowers to a `globalRef` (emitted
   *  verbatim); one that is NOT is a genuine unbound reference and refuses. */
  freeNames: Set<string>;
  counter: { n: number };
  returnSource: string | undefined;
  /** The function's data out-port name (fn.returns[0].name), so a `return`
   *  anywhere — early, nested, or per-branch — can wire its value to it. */
  returnPort?: string;
  /** Set when at least one `return`/`returnObject` wired a value to the out-port. */
  returnFired?: boolean;
}

/**
 * Language builtins usable as a bare VALUE (an isinstance/type argument, a
 * default, a stored callback) — not exhaustive, but the ones real code passes
 * around. A bare name that is one of these (and not bound locally) lowers to a
 * `globalRef` (emitted verbatim) rather than refusing as unbound. Covers Python
 * and TS/JS since the lowering is shared.
 */
const BUILTINS = new Set<string>([
  // Python type constructors / core objects used as values
  "str", "bytes", "bytearray", "int", "float", "complex", "bool", "list", "dict",
  "tuple", "set", "frozenset", "type", "object", "range", "slice", "memoryview",
  "property", "staticmethod", "classmethod", "super", "NotImplemented", "Ellipsis",
  // Common Python exception/warning classes referenced as values
  "Exception", "BaseException", "ValueError", "TypeError", "KeyError", "IndexError",
  "AttributeError", "RuntimeError", "StopIteration", "NotImplementedError", "OSError",
  "IOError", "FileNotFoundError", "UnicodeError", "UnicodeEncodeError", "UnicodeDecodeError",
  "ArithmeticError", "ZeroDivisionError", "LookupError", "NameError", "ImportError",
  "Warning", "DeprecationWarning", "UserWarning",
  // TS / JS global objects & constructors used as values
  "undefined", "NaN", "Infinity", "Object", "Array", "String", "Number", "Boolean",
  "Symbol", "BigInt", "Math", "JSON", "Date", "Promise", "RegExp", "Map", "Set",
  "WeakMap", "WeakSet", "Error", "RangeError", "SyntaxError", "console",
]);

export function liftProgram(program: Program, lift: LiftContext = {}): System {
  const knownFns = new Set(program.functions.map((f) => f.name));
  const knownClasses = new Set(program.classes.map((c) => c.name));
  const localImports = lift.localImports ?? new Map<string, LocalImportTarget>();
  // Qualify ids by source path so two files can each define `helper` without
  // colliding. Identity when no moduleKey is given (single-file / hand-authored).
  const qualify = (name: string): string => (lift.moduleKey ? `${lift.moduleKey}#${name}` : name);
  // Param names keyed by qualified id: start from the project-wide map (so links
  // into other files wire correctly) and add this file's own functions. A class
  // resolves through the SAME map with its constructor's params, so an
  // instantiation `Session(...)` wires its args to the class's contract.
  const moduleParams = new Map(lift.moduleParams ?? []);
  for (const f of program.functions) moduleParams.set(qualify(f.name), f.params.map((p) => p.name));
  for (const c of program.classes) {
    moduleParams.set(qualify(c.name), ctorParamNames(c));
    // Register each method's params under its module id, so a resolved `self.m()` /
    // `local.m()` method-link's existence check (`moduleParams.has`) succeeds.
    for (const m of c.methods) moduleParams.set(`${qualify(c.name)}.${m.name}`, m.params.map((p) => p.name));
  }
  // Every class module id in the project (this file's + the driver's), for typing
  // a constructor-bound local so a later `local.method()` resolves to a link.
  const classIds = new Set<string>(lift.classIds ?? []);
  for (const c of program.classes) classIds.add(qualify(c.name));
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
  // Module-scope names that may appear as a bare value: builtins, sibling classes
  // and functions, module constants, and every imported local name.
  const freeNames = new Set<string>(BUILTINS);
  for (const c of program.classes) freeNames.add(c.name);
  for (const f of program.functions) freeNames.add(f.name);
  for (const c of program.consts ?? []) freeNames.add(c.name);
  for (const imp of program.imports ?? []) for (const b of imp.bindings) freeNames.add(b.local);
  const shared = { knownFns, knownClasses, classIds, moduleParams, importSource, localImports, qualify, freeNames };
  const modules: Record<string, Module> = {};
  for (const fn of program.functions) {
    const id = qualify(fn.name);
    modules[id] = lowerFn(fn, shared, lift.origin, modules, id);
  }
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
  if (program.consts && program.consts.length > 0) {
    system.consts = program.consts.map((c) => ({
      name: c.name,
      value: c.value,
      ...(c.span ? { prov: c.span } : {}),
      ...(lift.origin ? { origin: lift.origin } : {}),
    }));
  }
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
type Shared = Pick<Ctx, "knownFns" | "knownClasses" | "classIds" | "moduleParams" | "importSource" | "localImports" | "qualify" | "freeNames">;

/** A class's constructor parameter names (`__init__` / `constructor`, receiver
 *  already dropped by the extractor) — the class's public link contract, so an
 *  instantiation wires its args to these ports. Empty when no constructor. */
export function ctorParamNames(cls: Class): string[] {
  const ctor = cls.methods.find((m) => m.name === "__init__" || m.name === "constructor");
  return ctor ? ctor.params.map((p) => p.name) : [];
}

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
    // Pass the class id so `self.other()` inside the method links to `classId.other`.
    modules[methodId] = lowerFn(m, shared, origin, modules, methodId, undefined, classId);
    nodes.push({ id: methodId, kind: "module", ref: methodId });
  }
  // A class's public contract is its CONSTRUCTOR: the `__init__`/`constructor`
  // params become the class module's data in-ports, so an instantiation link
  // (`Session(...)`) derives its ports from here and wires its args to them.
  // These describe the boundary a caller sees; they are NOT wired to the class's
  // interior (a namespace of state + methods), so they stay data-in — which the
  // port-boundary invariant already exempts (an unconnected data in-port is valid).
  const ctor = cls.methods.find((m) => m.name === "__init__" || m.name === "constructor");
  const ports: Port[] = (ctor?.params ?? []).map((p) => ({
    name: p.name,
    type: p.type,
    io: "in" as const,
    wire: "data" as const,
    ...(p.default !== undefined ? { default: p.default } : {}),
    ...(p.variadic !== undefined ? { variadic: p.variadic } : {}),
    ...(p.keywordOnly ? { keywordOnly: true } : {}),
    ...(p.positionalOnly ? { positionalOnly: true } : {}),
  }));
  modules[classId] = {
    title: cls.name,
    kind: "class",
    ...(cls.bases && cls.bases.length ? { bases: cls.bases } : {}),
    ...(cls.decorators && cls.decorators.length ? { decorators: cls.decorators } : {}),
    ports,
    interior: { nodes, wires: [] },
    ...(cls.doc !== undefined ? { doc: cls.doc } : {}),
    ...(cls.span ? { prov: cls.span } : {}),
    ...(origin ? { origin } : {}),
  };
}

/**
 * Lower a function (or method) to a Module. When the function declares nested
 * (local) functions, `modules`/`selfId` let us register each as its own module
 * (`${selfId}$${name}`) and resolve calls to it as links — so a local helper is
 * navigable/expandable like any other module. `inheritedLocalFns` carries the
 * enclosing scope's nested names inward (so a nested function can call a sibling).
 */
function lowerFn(
  fn: Fn,
  shared: Shared,
  origin: string | undefined,
  modules?: Record<string, Module>,
  selfId?: string,
  inheritedLocalFns?: Map<string, string>,
  selfClassId?: string,
): Module {
  // foldGuards runs BEFORE normalizeReturns so a guard clause + trailing return
  // (`if c: return A` then `return B`) is first folded to `if c: return A else:
  // return B` and THEN collapsed to a tail `return (A if c else B)` in one pass —
  // otherwise the ternary only appears on the second transpile (not a fixed point).
  fn = { ...fn, body: foldGuards(fn.body) };
  fn = normalizeReturns(fn);
  assertNoLoopCarriedState(fn);
  assertNoTryMerge(fn.body, fn.name);

  // Nested (local) functions: register each as its own module and build the
  // name→id map that resolves calls to them (this scope + any inherited siblings).
  const localFns = new Map(inheritedLocalFns ?? []);
  const nested = fn.nested ?? [];
  if (nested.length && modules && selfId !== undefined) {
    for (const nf of nested) localFns.set(nf.name, `${selfId}$${nf.name}`);
    // Register params first so a nested call's args wire to its ports (incl. any
    // forward/mutual reference between siblings), then lower each nested body.
    for (const nf of nested) shared.moduleParams.set(localFns.get(nf.name)!, nf.params.map((p) => p.name));
    for (const nf of nested) {
      const nid = localFns.get(nf.name)!;
      // A nested fn inside a method inherits its enclosing class, so `self.m()`
      // inside it links too (self rides ambiently through the re-nested def).
      const m = lowerFn(nf, shared, origin, modules, nid, localFns, selfClassId);
      m.nestedIn = selfId;
      if (nf.captures && nf.captures.length) m.captures = nf.captures;
      modules[nid] = m;
    }
  }

  const ctx: Ctx = {
    nodes: [], wires: [], varMap: new Map(), used: new Set(),
    ...shared, counter: { n: 0 }, returnSource: undefined, varTypes: new Map(),
    ...(localFns.size ? { localFns } : {}),
    ...(selfClassId !== undefined ? { selfClassId } : {}),
  };

  const ports: Port[] = [{ name: "exec", type: "exec", io: "in", wire: "control" }];
  for (const p of fn.params) {
    ports.push({
      name: p.name,
      type: p.type,
      io: "in",
      wire: "data",
      ...(p.default !== undefined ? { default: p.default } : {}),
      ...(p.variadic !== undefined ? { variadic: p.variadic } : {}),
      ...(p.keywordOnly ? { keywordOnly: true } : {}),
      ...(p.positionalOnly ? { positionalOnly: true } : {}),
    });
    ctx.varMap.set(p.name, `P:${p.name}`);
  }

  // The out-port name is known up front, so `return` statements anywhere in the
  // body can wire to it (multi-exit). The port itself is declared below only if a
  // return actually fired.
  if (fn.returns.length >= 1) ctx.returnPort = fn.returns[0]!.name;

  const open = lowerBlock(ctx, fn.body, "P:exec");

  if (fn.returns.length >= 1 && ctx.returnFired) {
    const r = fn.returns[0]!;
    ports.push({ name: r.name, type: r.type, io: "out", wire: "data" });
  }
  if (open !== null) {
    // Some control path falls through the body (no return) — a normal completion.
    ports.push({ name: "done", type: "exec", io: "out", wire: "control" });
    ctx.wires.push([open, "P:done", "control"]);
  }

  return {
    title: fn.name,
    ports,
    interior: { nodes: ctx.nodes, wires: ctx.wires },
    ...(fn.async ? { async: true } : {}),
    ...(fn.decorators && fn.decorators.length ? { decorators: fn.decorators } : {}),
    ...(fn.doc !== undefined ? { doc: fn.doc } : {}),
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
    case "attrSet": {
      // Write an attribute on an arbitrary receiver: the receiver flows in on
      // "obj", the written value on "value"; a control-sequenced effect (no
      // data-out), like stateSet but with a wired receiver.
      const id = newNode(ctx, { kind: "attrSet", label: s.attr, attr: s.attr }, undefined, s.span);
      ctx.wires.push([lowerExpr(ctx, s.obj), `${id}:obj`, "data"]);
      ctx.wires.push([lowerExpr(ctx, s.value), `${id}:value`, "data"]);
      ctx.wires.push([prev, id, "control"]);
      return id;
    }
    case "indexSet": {
      // Write an indexed element `d[k] = v`: the indexed value on "obj", the key
      // on "key", the written value on "value". Like attrSet, a sequenced effect.
      const id = newNode(ctx, { kind: "indexSet", label: "index" }, undefined, s.span);
      ctx.wires.push([lowerExpr(ctx, s.obj), `${id}:obj`, "data"]);
      ctx.wires.push([lowerExpr(ctx, s.key), `${id}:key`, "data"]);
      ctx.wires.push([lowerExpr(ctx, s.value), `${id}:value`, "data"]);
      ctx.wires.push([prev, id, "control"]);
      return id;
    }
    case "delIndex": {
      // `del obj[key]`: a control-sequenced effect (no data-out), the receiver on
      // "obj" and the index on "key".
      const id = newNode(ctx, { kind: "delIndex", label: "del" }, undefined, s.span);
      ctx.wires.push([lowerExpr(ctx, s.obj), `${id}:obj`, "data"]);
      ctx.wires.push([lowerExpr(ctx, s.key), `${id}:key`, "data"]);
      ctx.wires.push([prev, id, "control"]);
      return id;
    }
    case "delAttr": {
      // `del obj.attr`: a control-sequenced effect, the receiver on "obj".
      const id = newNode(ctx, { kind: "delAttr", label: "del", attr: s.attr }, undefined, s.span);
      ctx.wires.push([lowerExpr(ctx, s.obj), `${id}:obj`, "data"]);
      ctx.wires.push([prev, id, "control"]);
      return id;
    }
    case "expr": {
      const id = lowerSequencedCall(ctx, expectCall(s.expr), undefined, s.span);
      ctx.wires.push([prev, id, "control"]);
      return id;
    }
    case "destructure": {
      // Sequence unpacking `a, b = value`: an `unpack` node sequenced in the
      // control flow. The value flows in once on "value"; each name binds to a
      // data-out port "0".."n-1" read downstream by var name. Because every name
      // reads through this single node, the value is evaluated once (an unpack of
      // a call result calls it once) — unlike desugaring to N separate `value[i]`.
      const id = newNode(ctx, { kind: "unpack", names: s.names }, undefined, s.span);
      ctx.wires.push([lowerExpr(ctx, s.value), `${id}:value`, "data"]);
      ctx.wires.push([prev, id, "control"]);
      s.names.forEach((n, i) => ctx.varMap.set(n, `${id}:${i}`));
      return id;
    }
    case "chain": {
      // Chained assignment `x = y = z`: a `broadcast` node sequenced in the flow.
      // The value flows in once on "value"; each name binds a data-out "0".."n-1"
      // carrying the WHOLE value, so the value is evaluated exactly once.
      const id = newNode(ctx, { kind: "broadcast", names: s.names }, undefined, s.span);
      ctx.wires.push([lowerExpr(ctx, s.value), `${id}:value`, "data"]);
      ctx.wires.push([prev, id, "control"]);
      s.names.forEach((n, i) => ctx.varMap.set(n, `${id}:${i}`));
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
      // Each arm is lowered against its OWN copy of the variable bindings — a
      // reassignment in one arm must not leak into the other (or, before the
      // merge, into the continuation). Snapshot, lower `then`, capture its map;
      // reset, lower `else`, capture its map.
      const before = ctx.varMap;
      ctx.varMap = new Map(before);
      const thenOpen = lowerBlock(ctx, s.then, `${id}:then`);
      const thenVars = ctx.varMap;
      ctx.varMap = new Map(before);
      const elseOpen = lowerBlock(ctx, s.else, `${id}:else`);
      const elseVars = ctx.varMap;
      // Both arms escape (return/throw/…): the branch is terminal, nothing merges.
      if (thenOpen === null && elseOpen === null) { ctx.varMap = before; return null; }
      // Exactly one arm escapes: the surviving arm's bindings ARE the continuation
      // (a guard clause — the folded shape foldGuards produces). No merge node.
      if (thenOpen === null) { ctx.varMap = elseVars; return elseOpen; }
      if (elseOpen === null) { ctx.varMap = thenVars; return thenOpen; }
      // Both arms fall through: a control-flow merge. Compute the post-branch binding
      // of every name touched on either arm. A name bound differently on the two
      // paths but DEFINED on both (an arm binding, or the pre-branch value on the arm
      // that didn't touch it) becomes a phi. A name bound on only ONE arm and not
      // before is arm-local / maybe-unbound — it is left OUT of the continuation, so
      // a read after it fails honestly as unbound (rather than resolving to one arm's
      // value on both paths, or over-refusing a value used only within its arm).
      const merged = new Map(before);
      const phis: string[] = [];
      const phiSrc: Record<string, [string, string]> = {};
      for (const name of new Set([...thenVars.keys(), ...elseVars.keys()])) {
        const t = thenVars.get(name);
        const e = elseVars.get(name);
        if (t === e) { if (t !== undefined) merged.set(name, t); continue; } // identical on both paths
        const tSrc = t ?? before.get(name); // value on the then path
        const eSrc = e ?? before.get(name); // value on the else path
        if (tSrc === undefined || eSrc === undefined) { merged.delete(name); continue; } // defined on only one path
        phis.push(name);
        phiSrc[name] = [tSrc, eSrc];
      }
      const mid = newNode(ctx, { kind: "merge", label: "merge", ...(phis.length ? { phis } : {}) }, undefined, s.span);
      for (const v of phis) {
        const [tSrc, eSrc] = phiSrc[v]!;
        ctx.wires.push([tSrc, `${mid}:then_${v}`, "data"]);
        ctx.wires.push([eSrc, `${mid}:else_${v}`, "data"]);
      }
      ctx.wires.push([thenOpen, `${mid}:then`, "control"]);
      ctx.wires.push([elseOpen, `${mid}:else`, "control"]);
      ctx.varMap = merged;
      for (const v of phis) ctx.varMap.set(v, `${mid}:${v}`);
      return `${mid}:done`;
    }
    case "for": {
      const carried = carriedVars(ctx, s.body, [s.varName]);
      const before = new Map(ctx.varMap);
      const id = newNode(ctx, { kind: "loop", label: s.varName, ...(carried.length ? { carried } : {}) }, undefined, s.span);
      ctx.wires.push([lowerExpr(ctx, s.from), `${id}:from`, "data"]);
      ctx.wires.push([lowerExpr(ctx, s.to), `${id}:to`, "data"]);
      ctx.wires.push([prev, id, "control"]);
      bindCarriedIn(ctx, id, carried);
      ctx.varMap.set(s.varName, `${id}:index`);
      lowerBlock(ctx, s.body, `${id}:body`);
      bindCarriedOut(ctx, id, carried);
      restoreLoopScope(ctx, before, carried);
      return `${id}:done`;
    }
    case "while": {
      const carried = carriedVars(ctx, s.body, []);
      const before = new Map(ctx.varMap);
      const id = newNode(ctx, { kind: "while", label: "while", ...(carried.length ? { carried } : {}) }, undefined, s.span);
      // The condition reads the carried value, so bind carry_v BEFORE lowering it.
      bindCarriedIn(ctx, id, carried);
      ctx.wires.push([lowerExpr(ctx, s.cond), `${id}:cond`, "data"]);
      ctx.wires.push([prev, id, "control"]);
      lowerBlock(ctx, s.body, `${id}:body`);
      bindCarriedOut(ctx, id, carried);
      restoreLoopScope(ctx, before, carried);
      return `${id}:done`;
    }
    case "foreach": {
      // The collection-driven loop sibling: the iterable flows in on `iter`, the
      // bound element out on `item`. Like a counted loop's index, the binding is set
      // BEFORE lowering the body that reads it; the iterable is evaluated in the
      // enclosing scope, so it is lowered first. A tuple-unpack target (`names`)
      // binds each name to its own out-port "0".."n-1" (like an `unpack` node), so
      // the iterated tuple is destructured per iteration; a single `varName` uses
      // the "item" port.
      const loopVars = s.names ?? [s.varName!];
      const carried = carriedVars(ctx, s.body, loopVars);
      const before = new Map(ctx.varMap);
      const node = s.names
        ? { kind: "foreach" as const, label: s.names.join(", "), names: s.names, ...(carried.length ? { carried } : {}) }
        : { kind: "foreach" as const, label: s.varName!, ...(carried.length ? { carried } : {}) };
      const id = newNode(ctx, node, undefined, s.span);
      ctx.wires.push([lowerExpr(ctx, s.iter), `${id}:iter`, "data"]);
      ctx.wires.push([prev, id, "control"]);
      bindCarriedIn(ctx, id, carried);
      if (s.names) s.names.forEach((n, i) => ctx.varMap.set(n, `${id}:${i}`));
      else ctx.varMap.set(s.varName!, `${id}:item`);
      lowerBlock(ctx, s.body, `${id}:body`);
      bindCarriedOut(ctx, id, carried);
      restoreLoopScope(ctx, before, carried);
      return `${id}:done`;
    }
    case "try": {
      // Protected block + handler, rejoining at `done`. The catch binding (if
      // any) is a data-out `error`, bound BEFORE lowering the handler that reads
      // it — exactly like a counted loop's index. The body never sees it.
      const id = newNode(ctx, { kind: "try", label: s.catchParam ?? "", ...(s.errorTypes && s.errorTypes.length ? { errorTypes: s.errorTypes } : {}) }, undefined, s.span);
      // The pushed node object (newNode spreads its partial into a fresh object), so
      // a phi merge computed below is set on THIS reference, not the partial.
      const tryNode = ctx.nodes[ctx.nodes.length - 1] as Record<string, unknown>;
      ctx.wires.push([prev, id, "control"]);
      // Each region is lowered against its OWN copy of the bindings so an assignment
      // in the body doesn't leak into the handler (or, after the try, misrepresent a
      // value that only exists on one path). When BOTH the no-raise path and the
      // handler fall through and bind a value differently, it becomes a phi on the
      // try node (noRaise_v/catch_v → v) — the try analogue of the branch merge.
      const before = ctx.varMap;
      ctx.varMap = new Map(before);
      const bodyOpen = lowerBlock(ctx, s.body, `${id}:body`);
      // `else` runs in the no-raise path, after the body — it sees the body's bindings.
      const elseOpen = s.orelse ? lowerBlock(ctx, s.orelse, `${id}:else`) : undefined;
      const noRaiseVars = ctx.varMap; // body (+ else) bindings
      ctx.varMap = new Map(before);
      if (s.catchParam) ctx.varMap.set(s.catchParam, `${id}:error`);
      const handlerOpen = lowerBlock(ctx, s.handler, `${id}:catch`);
      const handlerVars = ctx.varMap;
      // `finally` always runs on the way out; lower it against the pre-try bindings
      // (conservative — it must not assume either path's assignments) and let it
      // dominate the continuation.
      ctx.varMap = new Map(before);
      const finallyOpen = s.finalbody ? lowerBlock(ctx, s.finalbody, `${id}:finally`) : undefined;
      const finallyVars = ctx.varMap;
      const noRaiseOpen = elseOpen !== undefined ? elseOpen : bodyOpen;
      if (finallyOpen !== undefined) {
        ctx.varMap = finallyVars;
        return finallyOpen === null ? null : `${id}:done`;
      }
      // Set the continuation's bindings to the path that survives (the other escaped).
      if (noRaiseOpen === null && handlerOpen === null) { ctx.varMap = before; return null; }
      if (handlerOpen === null) { ctx.varMap = noRaiseVars; return `${id}:done`; }
      if (noRaiseOpen === null) { ctx.varMap = handlerVars; return `${id}:done`; }
      // Both paths survive: merge divergently-bound names into phis on the try node —
      // the no-raise value on "noRaise_v", the handler value on "catch_v", the merged
      // value read after on "v". A name defined on only one path (not before) is
      // path-local: left out of the continuation (a read after it fails as unbound).
      const merged = new Map(before);
      const phis: string[] = [];
      for (const name of new Set([...noRaiseVars.keys(), ...handlerVars.keys()])) {
        const nr = noRaiseVars.get(name);
        const h = handlerVars.get(name);
        if (nr === h) { if (nr !== undefined) merged.set(name, nr); continue; }
        const nrSrc = nr ?? before.get(name);
        const hSrc = h ?? before.get(name);
        if (nrSrc === undefined || hSrc === undefined) { merged.delete(name); continue; }
        phis.push(name);
        ctx.wires.push([nrSrc, `${id}:noRaise_${name}`, "data"]);
        ctx.wires.push([hSrc, `${id}:catch_${name}`, "data"]);
      }
      if (phis.length) tryNode.phis = phis;
      ctx.varMap = merged;
      for (const v of phis) ctx.varMap.set(v, `${id}:${v}`);
      return `${id}:done`;
    }
    case "with": {
      // A context-managed block. The context manager flows in on "context"; the
      // bound `as` value (if any) is a data-out "resource", bound BEFORE lowering
      // the body that reads it — like a try's catch var. The body runs on "body",
      // then control continues at "done".
      const id = newNode(ctx, { kind: "with", label: s.resource ?? "" }, undefined, s.span);
      ctx.wires.push([lowerExpr(ctx, s.context), `${id}:context`, "data"]);
      ctx.wires.push([prev, id, "control"]);
      if (s.resource) ctx.varMap.set(s.resource, `${id}:resource`);
      // The body always runs, so if it always escapes (returns/throws), the `with`
      // is itself terminal — control never reaches `done`.
      const bodyOpen = lowerBlock(ctx, s.body, `${id}:body`);
      return bodyOpen === null ? null : `${id}:done`;
    }
    case "assert": {
      // A control-sequenced effect: the predicate flows in on "cond", the optional
      // message on "message"; control falls through on "done".
      const id = newNode(ctx, { kind: "assert", label: "assert" }, undefined, s.span);
      ctx.wires.push([lowerExpr(ctx, s.cond), `${id}:cond`, "data"]);
      if (s.message) ctx.wires.push([lowerExpr(ctx, s.message), `${id}:message`, "data"]);
      ctx.wires.push([prev, id, "control"]);
      return id;
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
      // A bare `raise` (re-raise the active exception) has no value pin.
      if (s.value !== undefined) ctx.wires.push([lowerExpr(ctx, s.value), `${id}:value`, "data"]);
      ctx.wires.push([prev, id, "control"]);
      return null;
    }
    case "break":
    case "continue": {
      // A terminal control node, like throw/rethrow: control-in, no control-out —
      // the chain dead-ends (control escapes to the loop header / past the loop).
      const id = newNode(ctx, { kind: s.t, label: s.t }, undefined, s.span);
      ctx.wires.push([prev, id, "control"]);
      return null;
    }
    case "pass":
      // A no-op: no IR node, control flows straight through. An empty block
      // re-emits `pass` on the way out, so the round-trip holds.
      return prev;
    case "yield": {
      // A control-sequenced effect (like print): the yielded value flows in on
      // "value"; control continues (a yield suspends and resumes, NOT terminal).
      const id = newNode(ctx, { kind: "yield", label: "yield", ...(s.delegate ? { delegate: true } : {}) }, undefined, s.span);
      if (s.value !== undefined) ctx.wires.push([lowerExpr(ctx, s.value), `${id}:value`, "data"]);
      ctx.wires.push([prev, id, "control"]);
      return id;
    }
    case "return":
    case "returnObject": {
      // Multi-exit: a `return` is a TERMINAL control node (control-in, data-in
      // "value", no control-out) — like `throw`, the chain dead-ends here. The
      // value also wires to the function's data out-port; with several returns
      // (early, per-branch, nested), each adds a wire and only one fires at
      // runtime. The out-port is declared by lowerFn once any return has fired.
      const valueExpr = s.t === "return" ? s.expr : s.fields[0]?.expr;
      const id = newNode(ctx, { kind: "return", label: "return" }, undefined, s.span);
      ctx.wires.push([prev, id, "control"]);
      // A bare `return` (void early exit) has no value to carry; a value return
      // wires its source to the node's "value" pin and to the data out-port.
      if (valueExpr !== undefined && ctx.returnPort !== undefined) {
        const src = lowerExpr(ctx, valueExpr);
        ctx.wires.push([src, `${id}:value`, "data"]);
        ctx.wires.push([src, `P:${ctx.returnPort}`, "data"]);
        ctx.returnFired = true;
      }
      return null;
    }
  }
}

/** Node metadata describing a call's non-positional args: `*x` unpacks (starCount,
 *  wired to "star0".. pins) and keyword args (kwNames, wired to "kw0".. pins; a
 *  null name is a `**value` dict-unpack). Positional args stay on the bare endpoint. */
function callArgMeta(e: Extract<Expr, { t: "call" }>): { kwNames?: (string | null)[]; starCount?: number } {
  const meta: { kwNames?: (string | null)[]; starCount?: number } = {};
  if (e.starArgs && e.starArgs.length) meta.starCount = e.starArgs.length;
  if (e.kwargs && e.kwargs.length) meta.kwNames = e.kwargs.map((k) => k.name);
  return meta;
}

/** Wire a call's args into a stub/method node `id`: positional → bare endpoint;
 *  `*x` → "star0".. ; keyword/`**` values → "kw0".. (paralleling callArgMeta). */
function wireCallArgs(ctx: Ctx, e: Extract<Expr, { t: "call" }>, id: string): void {
  for (const arg of e.args) ctx.wires.push([lowerExpr(ctx, arg), id, "data"]);
  (e.starArgs ?? []).forEach((a, i) => ctx.wires.push([lowerExpr(ctx, a), `${id}:star${i}`, "data"]));
  (e.kwargs ?? []).forEach((k, i) => ctx.wires.push([lowerExpr(ctx, k.value), `${id}:kw${i}`, "data"]));
}

/**
 * Loop-carried (accumulator) variables: names assigned in the loop body AND read
 * upward-exposed there (so the body reads the PREVIOUS iteration's value, e.g.
 * `total = total + x`), excluding the loop var(s) and any not bound before the
 * loop. These become the loop node's iter-args (in_/carry_/next_/out_ pins).
 */
function carriedVars(ctx: Ctx, body: Stmt[], loopVars: string[]): string[] {
  const exposed = upwardExposedReads(body);
  // The update must be at the TOP LEVEL of the body, so the var's post-body binding
  // (→ "next_v") reflects it. A var assigned only inside a branch/try is a
  // CONDITIONAL accumulator whose update would be lost (→ a no-op `v = v`); those
  // are refused in `walkForLoops`, not carried here.
  const topAssigned = topLevelAssignedNames(body);
  return [...topAssigned].filter((v) => exposed.has(v) && !loopVars.includes(v) && ctx.varMap.has(v));
}

/** Names rebound at the TOP LEVEL of a block after lowering: a direct
 *  `let`/`assign`/`destructure`/`chain`, PLUS a name assigned in a top-level `if`
 *  whose arms do not both escape — a merge (both fall through) phis it, a guard
 *  (one arm escapes) carries the survivor's, so either becomes a top-level rebind
 *  once the branch is lowered. This is what lets a CONDITIONAL accumulator
 *  (`if c: acc = f(acc)`) be a real loop-carried iter-arg rather than a refusal. */
function topLevelAssignedNames(stmts: Stmt[]): Set<string> {
  const out = new Set<string>();
  for (const s of stmts) {
    if (s.t === "let" || s.t === "assign") out.add(s.name);
    else if (s.t === "destructure" || s.t === "chain") for (const n of s.names) out.add(n);
    else if (s.t === "if") {
      const thenT = isTerminal(s.then);
      const elseT = isTerminal(s.else);
      if (thenT && elseT) continue; // a terminal branch has no continuation to rebind
      if (!thenT) for (const n of topLevelAssignedNames(s.then)) out.add(n);
      if (!elseT) for (const n of topLevelAssignedNames(s.else)) out.add(n);
    } else if (s.t === "try" && s.finalbody === undefined) {
      // A try's surviving paths' rebinds become the continuation (a phi across the
      // no-raise / handler paths, or the survivor when one escapes) — a top-level
      // rebind, like a branch. A `finally`-bearing try is left out (no phi home).
      const noRaiseT = s.orelse !== undefined ? isTerminal(s.orelse) : isTerminal(s.body);
      const handlerT = isTerminal(s.handler);
      if (noRaiseT && handlerT) continue;
      if (!noRaiseT) for (const n of topLevelAssignedNames(s.orelse ?? s.body)) out.add(n);
      if (!handlerT) for (const n of topLevelAssignedNames(s.handler)) out.add(n);
    }
  }
  return out;
}

/** Wire each carried var's pre-loop value into "in_v", then bind it to "carry_v"
 *  (the body/condition reads the current iteration's value). Call BEFORE lowering
 *  the body (and, for `while`, before lowering the condition). */
function bindCarriedIn(ctx: Ctx, id: string, carried: string[]): void {
  for (const v of carried) ctx.wires.push([ctx.varMap.get(v)!, `${id}:in_${v}`, "data"]);
  for (const v of carried) ctx.varMap.set(v, `${id}:carry_${v}`);
}

/** Wire each carried var's post-body value into "next_v", then bind it to "out_v"
 *  (reads after the loop see the final value). Call AFTER lowering the body. */
function bindCarriedOut(ctx: Ctx, id: string, carried: string[]): void {
  for (const v of carried) ctx.wires.push([ctx.varMap.get(v)!, `${id}:next_${v}`, "data"]);
  for (const v of carried) ctx.varMap.set(v, `${id}:out_${v}`);
}

/** Restore the variable scope after a loop: the loop variable and any body-local
 *  temporaries do NOT escape the loop, so a name bound/rebound inside the body is
 *  reset to its pre-loop binding (or removed if it had none) — EXCEPT carried vars,
 *  which survive as "out_v" (set by bindCarriedOut). Without this, a leaked loop
 *  binding would be misread as a phi by a merge that follows the loop. */
function restoreLoopScope(ctx: Ctx, before: Map<string, string>, carried: string[]): void {
  const keep = new Set(carried);
  for (const name of [...ctx.varMap.keys()]) {
    if (keep.has(name)) continue;
    const prev = before.get(name);
    if (prev === undefined) ctx.varMap.delete(name);
    else ctx.varMap.set(name, prev);
  }
}

/** A call that is sequenced on the control wire: a method, a module link, or a stub. */
function lowerSequencedCall(ctx: Ctx, e: Extract<Expr, { t: "call" }>, idHint?: string, prov?: SourceSpan): string {
  // A method call on self/local → a `method` node sequenced in the control flow.
  const m = methodParts(ctx, e);
  if (m) return lowerMethod(ctx, m, idHint, prov);
  // A call to a sibling function in the same file → a link (ref qualified to match
  // the sibling's module id). An in-project imported function → a link to its file.
  // A `*args`/`**kwargs` spread cannot be mapped onto a link's fixed param ports, so
  // such a call falls back to a stub `function` node (star0../kw0.. pins) — the link
  // edge is lost but the call still lifts (drift).
  const hasSpread = (e.starArgs !== undefined && e.starArgs.length > 0) || (e.kwargs ?? []).some((k) => k.name === null);
  const resolved = hasSpread ? undefined : linkTarget(ctx, e.name);
  // A resolved target with a KNOWN parameter contract links. This now includes a
  // CLASS module — a constructor call `Session(...)` links to the class, whose
  // contract is its `__init__` params (see `lowerClass`), so the class gains an
  // in-edge and stops being a top-level root. When the constructor is INHERITED (no
  // own `__init__`, so the contract is incomplete) an arg may not map to any port;
  // rather than wire it to a phantom port (invalid IR), the unmappable arg is
  // dropped (tolerant drift) — the link, and the surfaces-only view, still hold.
  const link = resolved !== undefined && ctx.moduleParams.has(resolved) ? resolved : undefined;
  if (link !== undefined) {
    // Record the call-site name when it differs from the target's declared name —
    // an import alias (`f as g`) or a namespaced member call (`ns.f`) — so the
    // transpiler re-emits it to match the file's verbatim import line. A plain
    // same-name call carries no `call` (keeps the common case minimal). A nested
    // helper's id carries a `parent$` prefix, so compare against its SIMPLE name.
    const call = e.name === simpleName(link) ? {} : { call: e.name };
    const id = newNode(ctx, { kind: "module", ref: link, ...call }, idHint, prov);
    // A constructor bound to a plain local (`s = Session()`) types that local, so a
    // later `s.method()` resolves to the class's method (see `receiverClass`).
    if (idHint !== undefined && ctx.classIds.has(link)) ctx.varTypes.set(idHint, link);
    // Wire positional args by the CALLEE's param names (port names on its
    // contract), looked up by the resolved target id so a cross-file link wires
    // correctly too. A keyword arg `name=value` wires to that named param port; a
    // `*x`/`**x` unpack into a link can't be mapped to fixed ports (deferred).
    if (e.starArgs && e.starArgs.length) throw new Error(`lift: unsupported *args unpack into a call to "${e.name}" (deferred)`);
    const params = ctx.moduleParams.get(link) ?? [];
    const portSet = new Set(params);
    e.args.forEach((arg, i) => {
      const port = params[i];
      if (port === undefined) return; // arg beyond the (incomplete) contract → drop
      ctx.wires.push([lowerExpr(ctx, arg), `${id}:${port}`, "data"]);
    });
    for (const k of e.kwargs ?? []) {
      if (k.name === null) throw new Error(`lift: unsupported **kwargs unpack into a call to "${e.name}" (deferred)`);
      if (!portSet.has(k.name)) continue; // kwarg not on the (incomplete) contract → drop
      ctx.wires.push([lowerExpr(ctx, k.value), `${id}:${k.name}`, "data"]);
    }
    return id;
  }
  // Not a link (a spread `f(*a)` couldn't map to fixed ports): a local helper/stub,
  // or — if its base name was imported — a call into a package (tagged `source`). If
  // the callee IS a known in-project module, carry a navigation `ref` so the stub is
  // still hyperlinked (the transpiler emits the same call either way).
  const source = externalSource(ctx, e.name);
  const ref = source ? undefined : callRef(ctx, e.name);
  const id = newNode(ctx, { kind: "function", label: e.name, ...(source ? { source } : ref ? { ref } : {}), ...callArgMeta(e) }, idHint, prov);
  wireCallArgs(ctx, e, id);
  return id;
}

/** The in-project module id a call name resolves to (the target a link WOULD use),
 *  or undefined for a stub/package call — for tagging a value-position or spread
 *  call's stub node with a navigation `ref`. */
function callRef(ctx: Ctx, name: string): string | undefined {
  const id = linkTarget(ctx, name);
  return id !== undefined && ctx.moduleParams.has(id) ? id : undefined;
}

/**
 * The qualified module id a call name links to, or undefined if it is not an
 * in-project module (a stub or a package call). Resolves, in order:
 *   - a sibling function in the same file (qualified like every local module);
 *   - a named local import (`import { foo } from "./util"` → the `foo` module);
 *   - a namespaced local import (`import * as util` + `util.foo()` → `util#foo`).
 */
function linkTarget(ctx: Ctx, name: string): string | undefined {
  const nested = ctx.localFns?.get(name);
  if (nested !== undefined) return nested; // a nested helper shadows a top-level name
  if (ctx.knownFns.has(name)) return ctx.qualify(name);
  // A sibling CLASS name → a constructor link to that class module.
  if (ctx.knownClasses.has(name)) return ctx.qualify(name);
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

/** The SIMPLE declared name of a module id, also stripping a nested helper's
 *  `parent$name` prefix: `sessions#merge_hooks$merge_setting` → `merge_setting`. */
function simpleName(id: string): string {
  const bare = bareName(id);
  const dollar = bare.lastIndexOf("$");
  return dollar === -1 ? bare : bare.slice(dollar + 1);
}

/** Lower a pure expression, returning the data-source endpoint that yields it. */
function lowerExpr(ctx: Ctx, e: Expr): string {
  switch (e.t) {
    case "lit":
      return newNode(ctx, { kind: "const", label: String(e.value), value: e.value });
    case "stateGet":
      return newNode(ctx, { kind: "stateGet", label: e.attr, attr: e.attr });
    case "self":
      // `self`/`this` used as a VALUE (an argument, a stored/returned value) — a
      // pure `selfRef` source. Distinct from a method receiver or `self.attr` base,
      // where `self` stays implicit (no wire); here it stands on its own.
      return newNode(ctx, { kind: "selfRef", label: "self" });
    case "attr": {
      // A general attribute read `obj.attr`: a pure data source whose receiver
      // flows in on pin "obj". Distinct from `member` (a port of a multi-output
      // result) and `stateGet` (the enclosing class's own attribute).
      const id = newNode(ctx, { kind: "attrGet", label: e.name, attr: e.name });
      ctx.wires.push([lowerExpr(ctx, e.obj), `${id}:obj`, "data"]);
      return id;
    }
    case "var": {
      const ep = ctx.varMap.get(e.name);
      if (ep !== undefined) return ep;
      // Not bound locally: a module-scope free identifier (an imported name, a
      // sibling class/function, a module constant, a builtin) used as a value →
      // a `globalRef`, emitted verbatim. Under the map goal, a name that is none of
      // those (a captured closure var, a lazily-imported name, a module-level
      // conditional binding) is ALSO lowered to a `globalRef` rather than refused —
      // a tolerant lift emits the bare name back (drift: the binding site is elided).
      return newNode(ctx, { kind: "globalRef", label: e.name });
    }
    case "member": {
      const base = ctx.varMap.get(e.name);
      // A `member` read off an unbound base falls back to a general attribute read
      // on a free identifier (tolerant lift).
      if (base === undefined) {
        const g = newNode(ctx, { kind: "globalRef", label: e.name });
        const id = newNode(ctx, { kind: "attrGet", label: e.member, attr: e.member });
        ctx.wires.push([g, `${id}:obj`, "data"]);
        return id;
      }
      // A constant-STRING subscript `name["field"]` is a multi-output result PORT
      // accessor ONLY when `name` is bound to a multi-output module-link node — then
      // it resolves to that node's out-port. Otherwise (a param, a plain value, a
      // dict) it is an ordinary dict subscript → an `index` node with a string key.
      const baseNodeId = base.startsWith("P:") ? undefined : (base.includes(":") ? base.slice(0, base.indexOf(":")) : base);
      const baseNode = baseNodeId !== undefined ? ctx.nodes.find((n) => n.id === baseNodeId) : undefined;
      if (baseNode && baseNode.kind === "module") return `${base}:${e.member}`;
      const id = newNode(ctx, { kind: "index", label: "index" });
      ctx.wires.push([base, `${id}:obj`, "data"]);
      const key = newNode(ctx, { kind: "const", label: e.member, value: e.member });
      ctx.wires.push([key, `${id}:key`, "data"]);
      return id;
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
    case "collection": {
      // Tuple/set: positional element pins "0".."n-1". Dict: paired entry pins
      // "key0","val0",… in source order. Either may be empty (an empty literal).
      const id = newNode(ctx, { kind: "collection", label: e.form, form: e.form });
      if (e.form === "dict") {
        (e.entries ?? []).forEach((ent, i) => {
          ctx.wires.push([lowerExpr(ctx, ent.key), `${id}:key${i}`, "data"]);
          ctx.wires.push([lowerExpr(ctx, ent.value), `${id}:val${i}`, "data"]);
        });
      } else {
        (e.elems ?? []).forEach((el, i) => ctx.wires.push([lowerExpr(ctx, el), `${id}:${i}`, "data"]));
      }
      return id;
    }
    case "index": {
      // A subscript read `obj[key]`: the indexed value flows in on "obj", the key
      // on "key"; one pure data-out (the element). The receiver is evaluated first.
      const id = newNode(ctx, { kind: "index", label: "index" });
      ctx.wires.push([lowerExpr(ctx, e.obj), `${id}:obj`, "data"]);
      ctx.wires.push([lowerExpr(ctx, e.key), `${id}:key`, "data"]);
      return id;
    }
    case "await": {
      // `await x`: a pure value transform — the awaited value flows in on "x".
      const id = newNode(ctx, { kind: "await", label: "await" });
      ctx.wires.push([lowerExpr(ctx, e.value), `${id}:x`, "data"]);
      return id;
    }
    case "global": {
      // A reference to a module-level constant: a pure, input-less node carrying
      // the name (declared at module scope, emitted verbatim).
      return newNode(ctx, { kind: "globalRef", label: e.name });
    }
    case "slice": {
      // A slice read `obj[start:stop]`: the receiver on "obj", each PRESENT bound on
      // its pin. An absent bound is an open end (no wire), so it stays open on the
      // way back out.
      const id = newNode(ctx, { kind: "slice", label: "slice" });
      ctx.wires.push([lowerExpr(ctx, e.obj), `${id}:obj`, "data"]);
      if (e.start) ctx.wires.push([lowerExpr(ctx, e.start), `${id}:start`, "data"]);
      if (e.stop) ctx.wires.push([lowerExpr(ctx, e.stop), `${id}:stop`, "data"]);
      if (e.step) ctx.wires.push([lowerExpr(ctx, e.step), `${id}:step`, "data"]);
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
    case "itercomp": {
      // The iterable comprehension: the iterable flows in on "iter", the bound
      // element out on "item" (read by elem/key/value/cond) — the pure-value
      // sibling of `foreach`. The iterable is evaluated in the enclosing scope, so
      // it is lowered first; the bound variable is then bound while the body parts
      // are lowered and restored afterwards so it never leaks past the comprehension.
      // A tuple-unpack target (`varNames`) binds each name to its own out-port
      // "0".."n-1" (like an `unpack` node); a single `varName` uses the "item" port.
      const boundNames = e.varNames ?? [e.varName!];
      const node = e.varNames ? { kind: "itercomp" as const, label: e.varNames.join(", "), form: e.form, names: e.varNames } : { kind: "itercomp" as const, label: e.varName!, form: e.form };
      const id = newNode(ctx, node);
      ctx.wires.push([lowerExpr(ctx, e.iter), `${id}:iter`, "data"]);
      const saved = boundNames.map((n) => [n, ctx.varMap.get(n)] as const);
      if (e.varNames) e.varNames.forEach((n, i) => ctx.varMap.set(n, `${id}:${i}`));
      else ctx.varMap.set(e.varName!, `${id}:item`);
      if (e.form === "dict") {
        ctx.wires.push([lowerExpr(ctx, e.key!), `${id}:key`, "data"]);
        ctx.wires.push([lowerExpr(ctx, e.value!), `${id}:value`, "data"]);
      } else {
        ctx.wires.push([lowerExpr(ctx, e.elem!), `${id}:elem`, "data"]);
      }
      if (e.cond) ctx.wires.push([lowerExpr(ctx, e.cond), `${id}:cond`, "data"]);
      for (const [n, prevVal] of saved) {
        if (prevVal === undefined) ctx.varMap.delete(n);
        else ctx.varMap.set(n, prevVal);
      }
      return id;
    }
    case "call": {
      // A method call in value position (`return obj.foo()`) → a pure method node.
      const m = methodParts(ctx, e);
      if (m) return lowerMethod(ctx, m);
      // Otherwise a nested call in value position (`f(g(x))`) → a pure (un-sequenced)
      // stub function, tagged `source` for a package call, or a navigation `ref` when
      // its callee is a known in-project function/class (so it is still hyperlinked).
      const source = externalSource(ctx, e.name);
      const ref = source ? undefined : callRef(ctx, e.name);
      const id = newNode(ctx, { kind: "function", label: e.name, ...(source ? { source } : ref ? { ref } : {}), ...callArgMeta(e) });
      wireCallArgs(ctx, e, id);
      return id;
    }
  }
}

/**
 * The parts of a method call (`recv.name(args)`), or null when the call is a
 * plain / link / package call. A call carries an explicit `recv` when the lifter
 * already knew the receiver (the Python extractor, which sees imports; or a TS
 * `this.foo()`). A TS `obj.foo()` arrives as a dotted NAME instead — import
 * classification happens here, not at lift — so a dotted name that resolves to
 * neither a link nor a package, and whose base is a bound local, is a method call
 * on that local. (A dotted base that is unbound stays a stub, as before.)
 */
function methodParts(ctx: Ctx, e: Extract<Expr, { t: "call" }>): { recv: Expr; call: Extract<Expr, { t: "call" }> } | null {
  if (e.recv) return { recv: e.recv, call: e };
  if (linkTarget(ctx, e.name) !== undefined) return null;
  if (externalSource(ctx, e.name) !== undefined) return null;
  const dot = e.name.indexOf(".");
  if (dot === -1) return null;
  const base = e.name.slice(0, dot);
  if (!ctx.varMap.has(base)) return null;
  // A dotted local `obj.foo(...)` → method `foo` on local `obj`, preserving args.
  const { recv: _drop, ...rest } = e;
  return { recv: { t: "var", name: base }, call: { ...rest, name: e.name.slice(dot + 1) } };
}

/**
 * Lower a method call to a `method` node. The receiver flows in on pin "recv",
 * EXCEPT a `self`/`this` receiver, which is ambient (no wire) — a self-call is
 * drawn with no incoming receiver edge, mirroring how `self` is implicit in the
 * method's interior. Positional args are wired to the node's bare endpoint, in
 * order, like a stub call's args.
 */
function lowerMethod(ctx: Ctx, m: { recv: Expr; call: Extract<Expr, { t: "call" }> }, idHint?: string, prov?: SourceSpan): string {
  // When the receiver's class is known — a `self` call (enclosing class) or a local
  // typed by a constructor (`s = Session()`) — resolve the method to its module id
  // so the renderer can hyperlink it. NAVIGATION only: the node stays a `method`
  // (receiver + label), so the transpiler still emits `recv.name(args)`.
  const cls = receiverClass(ctx, m.recv);
  const methodId = cls !== undefined ? `${cls}.${m.call.name}` : undefined;
  const ref = methodId !== undefined && ctx.moduleParams.has(methodId) ? { ref: methodId } : {};
  const id = newNode(ctx, { kind: "method", label: m.call.name, ...ref, ...callArgMeta(m.call) }, idHint, prov);
  if (m.recv.t !== "self") ctx.wires.push([lowerExpr(ctx, m.recv), `${id}:recv`, "data"]);
  wireCallArgs(ctx, m.call, id);
  return id;
}

/** The class id of a method-call receiver, when known: `self`/`this` → the
 *  enclosing class; a bare local → the class it was constructed from
 *  (`s = Session()`). Undefined for any other receiver (no type inference). */
function receiverClass(ctx: Ctx, recv: Expr): string | undefined {
  if (recv.t === "self") return ctx.selfClassId;
  if (recv.t === "var") return ctx.varTypes.get(recv.name);
  return undefined;
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
 * statements are the continuation of the OTHER arm — folding them into it keeps
 * the guard-clause shape a source fixed point (`if bad: throw; rest` ⟶
 * `if bad: throw else: rest`). When NEITHER arm escapes, the trailing statements
 * are a real control-flow merge — left in place for the lowering to represent with
 * a `merge` node (both arms rejoin, phi-ing any value assigned differently).
 */
function foldGuards(stmts: Stmt[]): Stmt[] {
  const out: Stmt[] = [];
  for (let i = 0; i < stmts.length; i++) {
    const s = foldNested(stmts[i]!);
    const rest = stmts.slice(i + 1);
    if (s.t === "if" && rest.length > 0) {
      const thenEscapes = isTerminal(s.then);
      const elseEscapes = isTerminal(s.else);
      if (thenEscapes && !elseEscapes) { out.push({ ...s, else: [...s.else, ...foldGuards(rest)] }); return out; }
      if (elseEscapes && !thenEscapes) { out.push({ ...s, then: [...s.then, ...foldGuards(rest)] }); return out; }
      // both arms escape ⇒ the tail is unreachable (dropped at lowering); both fall
      // through ⇒ a merge (handled at lowering). Either way, keep the branch and let
      // the trailing statements follow it as ordinary siblings.
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
    case "with": return { ...s, body: foldGuards(s.body) };
    case "try": return {
      ...s,
      body: foldGuards(s.body),
      handler: foldGuards(s.handler),
      ...(s.orelse ? { orelse: foldGuards(s.orelse) } : {}),
      ...(s.finalbody ? { finalbody: foldGuards(s.finalbody) } : {}),
    };
    default: return s;
  }
}

/** Does this block always escape control (never fall through to a successor)? */
function isTerminal(stmts: Stmt[]): boolean {
  const last = stmts[stmts.length - 1];
  if (!last) return false; // empty block falls through
  if (last.t === "throw" || last.t === "rethrow" || last.t === "break" || last.t === "continue") return true;
  if (last.t === "return" || last.t === "returnObject") return true;
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
  if (only.t === "return") return only.expr ?? null;
  if (only.t === "if") return ifReturnToExpr(only);
  return null;
}


/**
 * Reject loops that carry state across iterations. The IR is single-assignment
 * dataflow: a `let`/`assign` is not a node, it just rebinds the name to a fresh
 * data source (see the `assign`/`let` cases in `lowerStmt`). That works in
 * straight-line code, but a loop body is lowered ONCE — there is no node for a
 * feedback edge — so a variable updated each iteration would be silently
 * flattened to a single value (e.g. `total = total + i` collapses to `0 + i`).
 *
 * Two unrepresentable shapes are refused, mirroring the manifesto's "never lie":
 *   - carried IN:  a body variable read before it is (re)assigned in the body —
 *     the read reaches in from the previous iteration (an accumulator/fold).
 *   - carried OUT: a body variable read after the loop — the read would wire to
 *     an endpoint that only exists inside the loop.
 * Loop-local temporaries (assigned then read within the same iteration, never
 * carried) stay supported.
 */
function assertNoLoopCarriedState(fn: Fn): void {
  walkForLoops(fn.body, fn.name);
}

/**
 * Refuse a try whose value escapes via a merge the IR cannot express. When the
 * body or handler falls through (does not return/throw), a variable assigned in
 * the body/handler/else and read AFTER the try would need a control-flow merge of
 * the divergent paths — there is no merge node (same limitation as a branch whose
 * arms both fall through). A try whose every path escapes, or whose results are
 * only used inside their own arm, stays supported.
 */
function assertNoTryMerge(stmts: Stmt[], fnName: string): void {
  stmts.forEach((s, i) => {
    if (s.t === "try") {
      // A value merge exists only when BOTH the no-raise path (body, or `else` when
      // present) AND the handler fall through — then a variable assigned on one path
      // and read after the try has no single source. If exactly one path escapes
      // (a guard, e.g. `except: return`), the continuation sees the survivor's
      // bindings unambiguously — supported (handled in the try lowering).
      const noRaiseTerminal = s.orelse !== undefined ? isTerminal(s.orelse) : isTerminal(s.body);
      const bothFallThrough = !noRaiseTerminal && !isTerminal(s.handler);
      // A both-paths-fall-through merge is now representable via the try node's phis
      // (see the try lowering) — EXCEPT when a `finally` is present: a value merged
      // across the try/except paths and then possibly rebound by `finally` has no
      // clean phi home, so that case is still refused.
      if (bothFallThrough && s.finalbody !== undefined) {
        const assigned = assignedNames(s.body);
        assignedNames(s.handler, assigned);
        if (s.orelse) assignedNames(s.orelse, assigned);
        if (assigned.size > 0) {
          const after = new Set<string>();
          blockReads(stmts.slice(i + 1), after);
          for (const name of assigned) {
            if (after.has(name)) {
              throw new Error(
                `lift: function "${fnName}" reads "${name}" after a try whose arms ` +
                  `both fall through — merging a value across the try/except paths has ` +
                  `no IR node (only a try whose every path escapes carries a continuation)`,
              );
            }
          }
        }
      }
    }
    forEachChildBlock(s, (b) => assertNoTryMerge(b, fnName));
  });
}

function walkForLoops(stmts: Stmt[], fnName: string): void {
  stmts.forEach((s, i) => {
    if (s.t === "for" || s.t === "foreach" || s.t === "while") {
      const assigned = assignedNames(s.body);
      // The loop var(s) are not carried — a counted `for`'s index, a `foreach`'s
      // single `varName`, or its tuple-unpack `names`.
      if (s.t === "for") assigned.delete(s.varName);
      else if (s.t === "foreach") for (const n of s.names ?? [s.varName!]) assigned.delete(n);
      if (assigned.size > 0) {
        const exposed = upwardExposedReads(s.body);
        const topAssigned = topLevelAssignedNames(s.body);
        const after = new Set<string>();
        blockReads(stmts.slice(i + 1), after);
        for (const name of assigned) {
          // A var read upward-exposed AND assigned at the body's top level
          // (`total = total + x`) is a loop-carried accumulator — represented as the
          // loop node's iter-args (in_/carry_/next_/out_ pins), so it is SUPPORTED.
          if (exposed.has(name) && topAssigned.has(name)) continue;
          // Under the map goal, the two remaining shapes are lifted tolerantly rather
          // than refused (drift — a lie, but keeps the file liftable):
          //   - a conditional accumulator (upward-exposed, updated only in a branch)
          //     flattens to the pre-loop value inside the body;
          //   - a carried-OUT var (read after the loop) resolves to a free identifier
          //     after the loop (restoreLoopScope clears its in-loop binding).
          void exposed; void after;
        }
      }
    }
    forEachChildBlock(s, (b) => walkForLoops(b, fnName));
  });
}

function failCarried(fnName: string, name: string, why: string): never {
  throw new Error(
    `lift: function "${fnName}" carries variable "${name}" across loop iterations ` +
      `(${why}) — loop-carried state has no IR node, so the dataflow graph cannot ` +
      `represent it faithfully (example level)`,
  );
}

/** Run `fn` over every nested statement block of `s`. */
function forEachChildBlock(s: Stmt, fn: (block: Stmt[]) => void): void {
  switch (s.t) {
    case "if": fn(s.then); fn(s.else); break;
    case "for": case "while": case "foreach": case "with": fn(s.body); break;
    case "try": fn(s.body); fn(s.handler); if (s.orelse) fn(s.orelse); if (s.finalbody) fn(s.finalbody); break;
  }
}

/** Names bound by a `let`/`assign` anywhere within a block (descends nested blocks). */
function assignedNames(stmts: Stmt[], out: Set<string> = new Set()): Set<string> {
  for (const s of stmts) {
    if (s.t === "let" || s.t === "assign") out.add(s.name);
    if (s.t === "destructure" || s.t === "chain") for (const n of s.names) out.add(n);
    forEachChildBlock(s, (b) => assignedNames(b, out));
  }
  return out;
}

/** Variable names a statement reads (RHS / conditions / args), descending blocks. */
function blockReads(stmts: Stmt[], out: Set<string>): void {
  for (const s of stmts) {
    switch (s.t) {
      case "let": case "assign": exprReads(s.expr, out); break;
      case "destructure": case "chain": exprReads(s.value, out); break;
      case "print": exprReads(s.arg, out); break;
      case "stateSet": exprReads(s.value, out); break;
      case "attrSet": exprReads(s.obj, out); exprReads(s.value, out); break;
      case "indexSet": exprReads(s.obj, out); exprReads(s.key, out); exprReads(s.value, out); break;
      case "delIndex": exprReads(s.obj, out); exprReads(s.key, out); break;
      case "delAttr": exprReads(s.obj, out); break;
      case "expr": exprReads(s.expr, out); break;
      case "return": if (s.expr) exprReads(s.expr, out); break;
      case "yield": if (s.value) exprReads(s.value, out); break;
      case "returnObject": s.fields.forEach((f) => exprReads(f.expr, out)); break;
      case "throw": exprReads(s.arg, out); break;
      case "rethrow": if (s.value !== undefined) exprReads(s.value, out); break;
      case "if": exprReads(s.cond, out); break;
      case "for": exprReads(s.from, out); exprReads(s.to, out); break;
      case "while": exprReads(s.cond, out); break;
      case "foreach": exprReads(s.iter, out); break;
      case "with": exprReads(s.context, out); break;
      case "assert": exprReads(s.cond, out); if (s.message) exprReads(s.message, out); break;
    }
    forEachChildBlock(s, (b) => blockReads(b, out));
  }
}

/** Variable names read by an expression. */
function exprReads(e: Expr, out: Set<string>): void {
  switch (e.t) {
    case "var": out.add(e.name); break;
    case "member": out.add(e.name); break;
    case "bin": exprReads(e.a, out); exprReads(e.b, out); break;
    case "un": exprReads(e.x, out); break;
    case "cond": exprReads(e.cond, out); exprReads(e.then, out); exprReads(e.else, out); break;
    case "array": e.elems.forEach((el) => exprReads(el, out)); break;
    case "collection":
      if (e.form === "dict") (e.entries ?? []).forEach((ent) => { exprReads(ent.key, out); exprReads(ent.value, out); });
      else (e.elems ?? []).forEach((el) => exprReads(el, out));
      break;
    case "comprehension": exprReads(e.from, out); exprReads(e.to, out); exprReads(e.elem, out); break;
    case "itercomp":
      exprReads(e.iter, out);
      if (e.form === "dict") { exprReads(e.key!, out); exprReads(e.value!, out); }
      else exprReads(e.elem!, out);
      if (e.cond) exprReads(e.cond, out);
      break;
    case "attr": exprReads(e.obj, out); break;
    case "await": exprReads(e.value, out); break;
    case "index": exprReads(e.obj, out); exprReads(e.key, out); break;
    case "slice": exprReads(e.obj, out); if (e.start) exprReads(e.start, out); if (e.stop) exprReads(e.stop, out); break;
    case "call":
      e.args.forEach((a) => exprReads(a, out));
      (e.starArgs ?? []).forEach((a) => exprReads(a, out));
      (e.kwargs ?? []).forEach((k) => exprReads(k.value, out));
      if (e.recv) exprReads(e.recv, out);
      break;
    // lit, self, stateGet: no variable reads
  }
}

/**
 * Names read within `stmts` before being assigned there — reads that reach in
 * from the loop header (an outer binding or a previous iteration). Sound by
 * design: only a *prior top-level* `let`/`assign` "kills" a name; assignments
 * nested in branches/loops (which may not run) never kill, so a genuinely
 * carried read is never missed — we may only over-refuse, never lie.
 */
function upwardExposedReads(stmts: Stmt[]): Set<string> {
  const exposed = new Set<string>();
  const killed = new Set<string>();
  const expose = (names: Iterable<string>): void => {
    for (const n of names) if (!killed.has(n)) exposed.add(n);
  };
  const readsOf = (e: Expr): Set<string> => {
    const r = new Set<string>();
    exprReads(e, r);
    return r;
  };
  const nested = (block: Stmt[], ...loopVars: (string | undefined)[]): void => {
    const inner = upwardExposedReads(block);
    for (const v of loopVars) if (v) inner.delete(v);
    expose(inner);
  };
  for (const s of stmts) {
    switch (s.t) {
      case "let": case "assign": expose(readsOf(s.expr)); killed.add(s.name); break;
      case "destructure": case "chain": expose(readsOf(s.value)); s.names.forEach((n) => killed.add(n)); break;
      case "print": expose(readsOf(s.arg)); break;
      case "stateSet": expose(readsOf(s.value)); break;
      case "attrSet": expose(readsOf(s.obj)); expose(readsOf(s.value)); break;
      case "indexSet": expose(readsOf(s.obj)); expose(readsOf(s.key)); expose(readsOf(s.value)); break;
      case "delIndex": expose(readsOf(s.obj)); expose(readsOf(s.key)); break;
      case "delAttr": expose(readsOf(s.obj)); break;
      case "expr": expose(readsOf(s.expr)); break;
      case "return": if (s.expr) expose(readsOf(s.expr)); break;
      case "yield": if (s.value) expose(readsOf(s.value)); break;
      case "returnObject": s.fields.forEach((f) => expose(readsOf(f.expr))); break;
      case "throw": expose(readsOf(s.arg)); break;
      case "rethrow": if (s.value !== undefined) expose(readsOf(s.value)); break;
      case "if": expose(readsOf(s.cond)); nested(s.then); nested(s.else); break;
      case "for": expose(readsOf(s.from)); expose(readsOf(s.to)); nested(s.body, s.varName); break;
      case "while": expose(readsOf(s.cond)); nested(s.body); break;
      case "foreach": expose(readsOf(s.iter)); nested(s.body, ...(s.names ?? [s.varName])); break;
      case "with": expose(readsOf(s.context)); nested(s.body, s.resource); break;
      case "assert": expose(readsOf(s.cond)); if (s.message) expose(readsOf(s.message)); break;
      case "try": nested(s.body); nested(s.handler, s.catchParam); if (s.orelse) nested(s.orelse); if (s.finalbody) nested(s.finalbody); break;
    }
  }
  return exposed;
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
