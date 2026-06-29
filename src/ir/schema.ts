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
 *    a `module` node carries ONLY a `ref`. Its ports are derived from
 *    `modules[ref].ports`, so a caller's view of the contract cannot drift from
 *    the definition. There is no place to restate ports incorrectly.
 */
import { z } from "zod";

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
 *   binary ops → "a", "b"      unary `not` → "x"      `print` → "value"
 */
export const Op = z.enum([
  "add", "sub", "mul", "div", "mod",
  "eq", "ne", "lt", "le", "gt", "ge",
  "and", "or", "not",
  "concat",
  "print",
]);

/**
 * A port is one endpoint of a module's PUBLIC CONTRACT. The set of a module's
 * ports must correspond exactly to the unconnected boundary of its interior
 * (the port-boundary invariant — checked in validate.ts).
 */
export const Port = z
  .object({
    name: z.string().min(1),
    /** Type is a label today; a real type system is issue #3. */
    type: z.string().min(1),
    io: PortIO,
    wire: WireKind,
  })
  .strict();

const nodeBase = { id: z.string().min(1) };

/**
 * Node kinds are abstract imperative concepts, deliberately language-agnostic
 * (no host-language specifics leak into the IR). All leaf kinds plus `module`
 * (a link). Every node has a unique-within-its-module `id` that wires reference.
 */
export const Node = z.discriminatedUnion("kind", [
  z.object({ ...nodeBase, kind: z.literal("function"), label: z.string(), op: Op.optional() }).strict(),
  z.object({ ...nodeBase, kind: z.literal("branch"), label: z.string() }).strict(),
  z.object({ ...nodeBase, kind: z.literal("loop"), label: z.string() }).strict(),
  // A condition-driven loop. Pins: data-in "cond"; control-out "body" and "done".
  // The counted `loop` carries from/to/index; a `while` carries only a predicate.
  z.object({ ...nodeBase, kind: z.literal("while"), label: z.string() }).strict(),
  // A collection-driven loop (for-each). Pins: data-in "iter" (the iterable);
  // data-out "item" (the bound element, read by the body); control-out "body" and
  // "done". The third loop sibling: `loop` counts a range, `while` tests a
  // predicate, `foreach` walks the elements of a value. `label` is the item var.
  z.object({ ...nodeBase, kind: z.literal("foreach"), label: z.string() }).strict(),
  // Protected execution (try/catch). Control-in enters the protected block;
  // control-out "body" runs it, "catch" runs the handler if it raises, and "done"
  // is the continuation after either path. Data-out "error" is the caught value
  // (catch-all semantics — the IR models no exception type), wired only when the
  // handler reads it. `label` is the catch binding name (like a loop's index var),
  // or "" when the source binds no variable. Its raising counterpart is `throw`.
  z.object({ ...nodeBase, kind: z.literal("try"), label: z.string() }).strict(),
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
  // A module node is a hyperlink. Ports are DERIVED from modules[ref].ports.
  z.object({ ...nodeBase, kind: z.literal("module"), ref: z.string().min(1) }).strict(),
  // --- class support (a class is a module of kind "class") ------------------
  // A stored attribute, drawn on the class canvas. `label` is the attribute
  // name; `type` is its type label (issue #3). It owns no flow — it is a cell.
  z.object({ ...nodeBase, kind: z.literal("state"), label: z.string(), type: z.string().min(1) }).strict(),
  // Read an attribute of the enclosing class: a pure data source (`this.attr`).
  z.object({ ...nodeBase, kind: z.literal("stateGet"), label: z.string(), attr: z.string().min(1) }).strict(),
  // Write an attribute of the enclosing class: a control-sequenced effect
  // (`this.attr = …`), with one data in-pin "value". Effects-as-control-nodes.
  z.object({ ...nodeBase, kind: z.literal("stateSet"), label: z.string(), attr: z.string().min(1) }).strict(),
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
    ports: z.array(Port),
    interior: Interior,
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
  })
  .strict();

export type PortIO = z.infer<typeof PortIO>;
export type WireKind = z.infer<typeof WireKind>;
export type Op = z.infer<typeof Op>;
export type Port = z.infer<typeof Port>;
export type Node = z.infer<typeof Node>;
export type Wire = z.infer<typeof Wire>;
export type Interior = z.infer<typeof Interior>;
export type Module = z.infer<typeof Module>;
export type System = z.infer<typeof System>;
