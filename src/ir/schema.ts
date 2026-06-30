/**
 * Kontur IR — structural schema (zod).
 *
 * This file defines *shape* only: what a well-formed IR document looks like as
 * data. Cross-references and the port-boundary invariant are NOT enforced here
 * (zod can't see across the document); they live in `validate.ts`.
 *
 * Design notes tied to the manifesto:
 *  - The IR is the single source of truth. Code and diagram are derived from it.
 *  - A Module IS a Node: a `module` node is a *link* to another module.
 *  - Issue #5 ("derived, not restated contracts") is handled structurally here:
 *    a `module` node carries a `ref` (plus an optional `call` emit-hint that does
 *    NOT affect the contract). Its ports are derived from `modules[ref].ports`, so
 *    a caller's view of the contract cannot drift from the definition. There is no
 *    place to restate ports incorrectly.
 */
import { z } from "zod";

/**
 * Provenance: the link from a derived IR node back to the concrete source span
 * it was lifted from. This is the "glue" between the visual representation and
 * the implementation — the source map that lets a human (or an LLM) resolve any
 * node to the exact code it stands for, and verify that small slice in isolation
 * rather than scanning the whole program.
 *
 * `line` is 1-based and `col` 0-based (CPython `ast`'s convention), so spans map
 * directly onto editor coordinates. Optional throughout the IR: a hand-authored
 * or AI-emitted graph need not carry provenance; only *lifted* graphs do.
 */
export const Pos = z.object({ line: z.number().int().nonnegative(), col: z.number().int().nonnegative() }).strict();
export const SourceSpan = z.object({ start: Pos, end: Pos }).strict();

/** Direction of a port relative to its owning module. */
export const PortIO = z.enum(["in", "out"]);

/** The two wire kinds (Blueprints-style hybrid control flow). */
export const WireKind = z.enum(["data", "control"]);

/**
 * Abstract operator vocabulary for `function`/`effect` nodes. Deliberately
 * language-agnostic — each op maps to syntax in every backend (e.g. `mod` →
 * JS `%`, Py `%`). A node with no `op` is an opaque named step (stub call).
 *
 * Pin conventions (the names wires use on the `to` endpoint):
 *   binary ops → "a", "b"      unary ops → "x"      `print` → "value"
 */
export const Op = z.enum([
  "add", "sub", "mul", "div", "mod",
  "eq", "ne", "lt", "le", "gt", "ge",
  // Identity (`is`/`is not`) and membership (`in`/`not in`) comparisons — like the
  // other comparison ops they sit on pins "a","b". Python round-trips them exactly;
  // TS has no equivalent, so they cross-compile one-way (identity → `===`/`!==`,
  // membership → `.includes()`) and the TS lifter never produces them.
  "is", "isnot", "in", "notin",
  "and", "or", "not",
  // Arithmetic/bitwise unary ops (operand on pin "x"): `-x`, `+x`, `~x`.
  "neg", "pos", "bitnot",
  "concat",
  "print",
]);

/**
 * A parameter's default value, carried on its in-data port so a defaulted
 * signature round-trips. Restricted to a literal or a bare name reference — the
 * two forms real signatures overwhelmingly use; a richer default expression is
 * deferred (it refuses loudly at lift rather than lifting to a lie). This is
 * signature fidelity, not dataflow: defaults are not lowered into the interior.
 */
export const ParamDefault = z.discriminatedUnion("t", [
  z.object({ t: z.literal("lit"), value: z.union([z.string(), z.number(), z.boolean(), z.null()]) }).strict(),
  z.object({ t: z.literal("var"), name: z.string().min(1) }).strict(),
]);

/**
 * A port is one endpoint of a module's PUBLIC CONTRACT. The set of a module's
 * ports must correspond exactly to the unconnected boundary of its interior
 * (the port-boundary invariant — checked in validate.ts), except that an in-data
 * port MAY be unconnected: an unused parameter is a faithful input the interior
 * simply ignores (`**kwargs` forwarded on, a param read by no branch).
 *
 * The optional fields below capture full Python/TS signature shape so it
 * round-trips, and are meaningful only on in-data ports (a parameter):
 *   - `default`   — the parameter's default value.
 *   - `variadic`  — `*args` ("args") / `**kwargs` ("kwargs") / TS rest ("args").
 *   - `keywordOnly` — a Python keyword-only parameter (declared after `*`).
 */
export const Port = z
  .object({
    name: z.string().min(1),
    /** Type is a label today; a real type system is issue #3. */
    type: z.string().min(1),
    io: PortIO,
    wire: WireKind,
    default: ParamDefault.optional(),
    variadic: z.enum(["args", "kwargs"]).optional(),
    keywordOnly: z.literal(true).optional(),
  })
  .strict();

const nodeBase = { id: z.string().min(1), prov: SourceSpan.optional() };

/**
 * Node kinds are abstract imperative concepts, deliberately language-agnostic
 * (no host-language specifics leak into the IR). All leaf kinds plus `module`
 * (a link). Every node has a unique-within-its-module `id` that wires reference.
 */
export const Node = z.discriminatedUnion("kind", [
  // A pure transform / call. `op` is the abstract operator (built-in). `source`,
  // when present, marks an EXTERNAL call into an imported package — the label is
  // the library API name (e.g. "chunk", "path.join") and `source` is the package
  // specifier it was imported from (e.g. "lodash", "path"). This is the audit
  // marker for a trust-boundary crossing; the import itself is recorded on
  // `System.imports`. `op` and `source` are mutually exclusive (a built-in op is
  // never external). Absent both ⇒ a local helper/stub call.
  z.object({ ...nodeBase, kind: z.literal("function"), label: z.string(), op: Op.optional(), source: z.string().min(1).optional() }).strict(),
  z.object({ ...nodeBase, kind: z.literal("branch"), label: z.string() }).strict(),
  z.object({ ...nodeBase, kind: z.literal("loop"), label: z.string() }).strict(),
  // A condition-driven loop. Pins: data-in "cond"; control-out "body" and "done".
  // The counted `loop` carries from/to/index; a `while` carries only a predicate.
  z.object({ ...nodeBase, kind: z.literal("while"), label: z.string() }).strict(),
  // A collection-driven loop (for-each). Pins: data-in "iter" (the iterable);
  // data-out "item" (the bound element, read by the body); control-out "body" and
  // "done". The third loop sibling: `loop` counts a range, `while` tests a
  // predicate, `foreach` walks the elements of a value. `label` is the item var.
  // When the loop target is a tuple-unpack (`for k, v in items:`), `names` (≥2)
  // holds the per-element bindings and the bound elements come out on data-out
  // ports "0".."n-1" (each read by var name) instead of "item"; `label` is unused.
  z.object({ ...nodeBase, kind: z.literal("foreach"), label: z.string(), names: z.array(z.string().min(1)).min(2).optional() }).strict(),
  // Protected execution (try/catch). Control-in enters the protected block;
  // control-out "body" runs it, "catch" runs the handler if it raises, and "done"
  // is the continuation after either path. Data-out "error" is the caught value
  // (catch-all semantics — the IR models no exception type), wired only when the
  // handler reads it. `label` is the catch binding name (like a loop's index var),
  // or "" when the source binds no variable. Its raising counterpart is `throw`.
  z.object({ ...nodeBase, kind: z.literal("try"), label: z.string() }).strict(),
  // A context-managed block (`with ctx as r: …`). Control-in enters; data-in
  // "context" is the context-manager expression; data-out "resource" is the bound
  // value (read inside the body), wired only when the source has an `as` clause;
  // control-out "body" runs the block and "done" continues after the manager
  // exits. `label` is the resource binding name (like a loop's index / a try's
  // catch var), or "" when there is no `as`. Python-faithful; TS emits a `using`
  // disposable block one-way (the TS lifter never produces it).
  z.object({ ...nodeBase, kind: z.literal("with"), label: z.string() }).strict(),
  // An assertion (`assert cond, message`). A control-sequenced effect: control-in
  // enters, control-out "done" continues (it falls through when the predicate
  // holds, raises otherwise). Data-in "cond" is the predicate; optional data-in
  // "message" is the failure message. No data-out. `label` is always "assert".
  // Python-faithful; TS emits `console.assert(...)` one-way.
  z.object({ ...nodeBase, kind: z.literal("assert"), label: z.string() }).strict(),
  // Raise an exception. Control-in enters; one data-in "value" is the message.
  // There is NO control-out: control leaves the visible graph (non-local), so the
  // node is TERMINAL — drawn as a dead-end, the honest picture of an escape. It is
  // the raising counterpart of `try`. The IR models "raise an error carrying a
  // message" (TS `throw new Error(msg)` / Py `raise Exception(msg)`); the optional
  // `errorType` names the error constructor for a typed/custom error (TS `throw new
  // TypeError(msg)` / Py `raise TypeError(msg)`). Absent ⇒ the catch-all
  // `Error`/`Exception`, mirroring `try`'s catch-all handler. `errorType` is the one
  // place the IR carries an exception type — a bare name passed across backends,
  // like any other identifier (e.g. a stub call). `label` is always "throw".
  z.object({ ...nodeBase, kind: z.literal("throw"), label: z.string(), errorType: z.string().min(1).optional() }).strict(),
  // Re-raise an EXISTING exception value (a bare rethrow). Like `throw`, it is
  // TERMINAL — control-in, one data-in "value", no control-out. The difference is
  // semantic and deliberate: `throw` constructs a fresh error from a message and
  // WRAPS it (`new Error(msg)` / `Exception(msg)`); `rethrow` passes its value on
  // UNCHANGED (`throw e` / `raise e`). The catch-all IR carries the value as-is —
  // typically a `try` node's caught-error binding wired straight into "value".
  z.object({ ...nodeBase, kind: z.literal("rethrow"), label: z.string() }).strict(),
  z.object({ ...nodeBase, kind: z.literal("effect"), label: z.string(), io: PortIO, op: Op.optional() }).strict(),
  z.object({ ...nodeBase, kind: z.literal("const"), label: z.string(), value: z.unknown() }).strict(),
  // A pure data multiplexer (a value-level conditional / ternary). Pins: data-in
  // "cond", "then", "else"; one data out. This is the data-wire analogue of the
  // control-wire `branch` — Blueprints' "Select" node.
  z.object({ ...nodeBase, kind: z.literal("select"), label: z.string() }).strict(),
  // A pure list constructor. Pins: data-in "0".."n-1" (the elements); one data out.
  z.object({ ...nodeBase, kind: z.literal("array"), label: z.string() }).strict(),
  // A pure list comprehension over an inclusive counted range. Pins: data-in
  // "from","to" (range bounds) and "elem" (the element expression, which may read
  // the bound index); data-out "index" (the bound variable) and one default out
  // (the resulting list). `label` is the bound variable name.
  z.object({ ...nodeBase, kind: z.literal("comprehension"), label: z.string() }).strict(),
  // A comprehension over an ARBITRARY iterable — the pure-value sibling of `foreach`,
  // exactly as `comprehension` is of the counted `loop`. `form` selects the
  // collection built: "list" / "set" / "dict" / "generator". Pins: data-in "iter"
  // (the iterable), then "elem" (the element expression — list/set/generator) OR
  // "key"+"value" (the dict entry), plus an optional "cond" (an `if` filter);
  // data-out "item" (the bound variable, read by elem/key/value/cond) and one
  // default out (the resulting collection). `label` is the bound variable name.
  // When the target is a tuple-unpack (`{k: v for k, v in items}`), `names` (≥2)
  // holds the per-element bindings and the bound elements come out on data-out
  // ports "0".."n-1" (each read by var name) instead of "item"; `label` is unused.
  // Multi-generator targets are refused at lift (deferred).
  z.object({ ...nodeBase, kind: z.literal("itercomp"), label: z.string(), form: z.enum(["list", "set", "dict", "generator"]), names: z.array(z.string().min(1)).min(2).optional() }).strict(),
  // A pure collection literal — the sibling of `array` (the list literal) for the
  // other three built-in collection types. `form` selects which: a tuple `(…)`,
  // set `{…}`, or dict `{k: v, …}`. Pins: for tuple/set, data-in "0".."n-1" (the
  // elements); for dict, data-in "key0","val0","key1","val1",… (the entries,
  // paired and in source order); one data out. An empty literal has no in-pins.
  z.object({ ...nodeBase, kind: z.literal("collection"), label: z.string(), form: z.enum(["tuple", "set", "dict"]) }).strict(),
  // A subscript read `obj[key]`: index a list/dict/string by an arbitrary key.
  // Pins: data-in "obj" (the indexed value) and "key" (the index expression); one
  // data out (the element). Distinct from `member` (a constant-STRING field of a
  // multi-output result); `index` is the general runtime subscript and round-trips
  // in BOTH backends (`obj[key]`). `label` is always "index".
  z.object({ ...nodeBase, kind: z.literal("index"), label: z.string() }).strict(),
  // A slice read `obj[start:stop]`: pins data-in "obj" plus EITHER optional bound
  // "start"/"stop" (an absent bound = an open end, `obj[:3]` / `obj[1:]`); one data
  // out. Python renders it faithfully (a source fixed point); TS has no slice form,
  // so it cross-compiles one-way to `obj.slice(start, stop)` and the TS lifter never
  // produces it — like `collection`'s set/dict forms. A step slice is refused at
  // lift (deferred). `label` is always "slice".
  z.object({ ...nodeBase, kind: z.literal("slice"), label: z.string() }).strict(),
  // A module node is a hyperlink. Ports are DERIVED from modules[ref].ports.
  // `call`, when present, is the name the caller invokes this link by, used when
  // it differs from the target's declared name: an import alias (`import { f as g }`
  // → "g") or a namespaced member access (`ns.f()` → "ns.f"). It is an EMIT HINT
  // only — the transpiler renders the call by this name so it matches the file's
  // verbatim import line; it never affects the derived contract. Absent ⇒ the
  // link is called by the target's bare name.
  z.object({ ...nodeBase, kind: z.literal("module"), ref: z.string().min(1), call: z.string().min(1).optional() }).strict(),
  // --- class support (a class is a module of kind "class") ------------------
  // A stored attribute, drawn on the class canvas. `label` is the attribute
  // name; `type` is its type label (issue #3). It owns no flow — it is a cell.
  z.object({ ...nodeBase, kind: z.literal("state"), label: z.string(), type: z.string().min(1) }).strict(),
  // Read an attribute of the enclosing class: a pure data source (`this.attr`).
  z.object({ ...nodeBase, kind: z.literal("stateGet"), label: z.string(), attr: z.string().min(1) }).strict(),
  // Read an attribute off an arbitrary receiver value: `obj.attr`. A pure data
  // source with one data-in pin "obj" (the receiver) and one data-out (the read
  // value). Unlike `stateGet` (the enclosing class's own `self.attr`), the
  // receiver is wired in, so any value — a param, a call result, a nested attr —
  // can be the base. `attr` is the attribute name, emitted verbatim.
  z.object({ ...nodeBase, kind: z.literal("attrGet"), label: z.string(), attr: z.string().min(1) }).strict(),
  // A method call on a receiver: `recv.label(args)`. Like a stub `function` call
  // but with a distinguished receiver. Pins: an optional data-in "recv" (the
  // receiver) plus positional arg wires (bare-node `to` endpoints, in order); one
  // data-out (the result). When NO "recv" wire is present the receiver is the
  // ambient `self`/`this` — a method calling a sibling on its own object — so a
  // self-call carries no receiver edge, mirroring how `self` is implicit in a
  // method's interior. `label` is the method name, emitted verbatim.
  z.object({ ...nodeBase, kind: z.literal("method"), label: z.string() }).strict(),
  // Write an attribute of the enclosing class: a control-sequenced effect
  // (`this.attr = …`), with one data in-pin "value". Effects-as-control-nodes.
  z.object({ ...nodeBase, kind: z.literal("stateSet"), label: z.string(), attr: z.string().min(1) }).strict(),
  // Write an attribute on an ARBITRARY receiver: `obj.attr = value` — the
  // write-side sibling of `attrGet`, a control-sequenced effect (like `stateSet`,
  // but the receiver is wired in). Pins: control-in/out, data-in "obj" (the
  // receiver) and "value"; no data-out (an assignment is a statement, not a
  // value). Unlike `stateSet` (the enclosing class's own `self.attr`), any value
  // can be the base. `attr` is the attribute name, emitted verbatim. Round-trips
  // in both backends (`obj.attr = v`).
  z.object({ ...nodeBase, kind: z.literal("attrSet"), label: z.string(), attr: z.string().min(1) }).strict(),
  // Write an indexed element: `obj[key] = value` — the write-side sibling of
  // `index`, a control-sequenced effect. Pins: control-in/out, data-in "obj" (the
  // indexed value), "key" (the index expression) and "value"; no data-out. The
  // general subscript-assignment lvalue, round-tripping in both backends
  // (`obj[key] = v`). `label` is always "index".
  z.object({ ...nodeBase, kind: z.literal("indexSet"), label: z.string() }).strict(),
  // Sequence-unpacking bind: `a, b, … = value` (Python `a, b = value`, TS
  // `const [a, b] = value`). A control-sequenced node (an assignment is a
  // statement): control-in/out, one data-in "value" (the sequence), and data-out
  // "0".."n-1" each carrying element i — read downstream as the corresponding
  // name in `names`. The value is evaluated ONCE (a single data-in), so unpacking
  // a call result calls it once — the reason this is a node rather than N
  // separate `obj[i]` binds. `names` are the target identifiers in order; there
  // is no `label` (cf. `module`). Round-trips in both backends.
  z.object({ ...nodeBase, kind: z.literal("unpack"), names: z.array(z.string().min(1)).min(2) }).strict(),
]);

/**
 * A wire is `[from, to, kind]`. Endpoints are encoded as strings:
 *   - "P:portName"        → this module's boundary port
 *   - "nodeId"            → a node (its default/sole port)
 *   - "nodeId:portName"   → a named port on a node (used for module-node ports)
 */
export const Wire = z.tuple([z.string().min(1), z.string().min(1), WireKind]);

export const Interior = z
  .object({
    nodes: z.array(Node),
    wires: z.array(Wire),
  })
  .strict();

export const Module = z
  .object({
    title: z.string().min(1),
    /**
     * What this module *is*. A "function" (default) has a control/data flow
     * interior; a "class" is a namespace whose interior holds `state` cells and
     * `module`-link nodes for its methods. Optional for back-compat: absent ⇒
     * "function".
     */
    kind: z.enum(["function", "class"]).optional(),
    /**
     * Base classes (inheritance) — meaningful only on a `class` module. Each entry
     * is a name or dotted name (`RequestException`, `collections.abc.MutableMapping`)
     * carried VERBATIM, like the `throw` node's `errorType`: a type identifier the
     * IR passes across backends without re-casing or resolving to a link. Declared
     * order is preserved (Python allows several bases; TS emits the first via
     * `extends`). Absent ⇒ no base class.
     */
    bases: z.array(z.string().min(1)).optional(),
    /**
     * Decorators applied to this module (a function, method, or class), outermost
     * first. Each entry is the decorator expression carried VERBATIM without its
     * leading `@` (`property`, `app.route('/x')`), like `bases`: opaque metadata
     * the IR passes across backends without analysing, re-emitted as `@<text>`
     * lines above the definition. Absent ⇒ no decorator.
     */
    decorators: z.array(z.string().min(1)).optional(),
    ports: z.array(Port),
    interior: Interior,
    /**
     * The module's docstring — the human text of a function/method/class doc
     * comment (Python docstring / TS JSDoc), captured verbatim so the
     * code → lift → transpile round-trip preserves it. Documentation, not flow:
     * it has no node and no wire. Absent ⇒ the source carried no doc.
     */
    doc: z.string().optional(),
    /** Provenance for the module as a whole (e.g. a function/method/class def). */
    prov: SourceSpan.optional(),
    /**
     * The project-relative source file this module was lifted from (e.g.
     * "src/util.ts"). Set only by the multi-file project driver, which qualifies
     * module ids by path so two files can each define a `helper` without
     * colliding. Absent for single-file lifts and hand-authored IR, where ids are
     * bare names. The transpiler regroups modules by `origin` to emit one file
     * each and reproduce that file's imports.
     */
    origin: z.string().min(1).optional(),
  })
  .strict();

/**
 * One binding introduced by an import (see `Import`). `local` is the in-body
 * name; `imported` (named only) is the package-side name so aliases round-trip.
 */
export const ImportBinding = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("named"), imported: z.string().min(1), local: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("default"), local: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("namespace"), local: z.string().min(1) }).strict(),
]);

/**
 * A package import. The IR records imports VERBATIM (source specifier + bindings)
 * so the transpiler can reproduce the original `import` line — without this the
 * `code → lift → transpile` round-trip drops every import. `bindings` is empty
 * for a bare side-effect import (`import "x"`). The audit view of a *used* import
 * is a `function` node carrying `source`; this list is the fidelity record.
 */
export const Import = z
  .object({
    source: z.string().min(1),
    bindings: z.array(ImportBinding),
    prov: SourceSpan.optional(),
    /**
     * The project-relative file this import statement belongs to (e.g.
     * "src/main.ts"). Set only by the multi-file driver so the transpiler can
     * reproduce each file's own import lines; absent for single-file lifts, where
     * every import belongs to the one file being emitted.
     */
    origin: z.string().min(1).optional(),
  })
  .strict();

/**
 * The whole system. `features` are entry-point canvases — just the module ids
 * you start navigating from (a feature is not its own kind of thing).
 */
export const System = z
  .object({
    features: z.array(z.string().min(1)),
    modules: z.record(z.string().min(1), Module),
    /** Package imports in source order. Optional: a graph need carry none. */
    imports: z.array(Import).optional(),
  })
  .strict();

export type Pos = z.infer<typeof Pos>;
export type SourceSpan = z.infer<typeof SourceSpan>;
export type PortIO = z.infer<typeof PortIO>;
export type WireKind = z.infer<typeof WireKind>;
export type Op = z.infer<typeof Op>;
export type ParamDefault = z.infer<typeof ParamDefault>;
export type Port = z.infer<typeof Port>;
export type ImportBinding = z.infer<typeof ImportBinding>;
export type Import = z.infer<typeof Import>;
export type Node = z.infer<typeof Node>;
export type Wire = z.infer<typeof Wire>;
export type Interior = z.infer<typeof Interior>;
export type Module = z.infer<typeof Module>;
export type System = z.infer<typeof System>;
