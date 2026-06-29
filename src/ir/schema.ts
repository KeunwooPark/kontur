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
  z.object({ ...nodeBase, kind: z.literal("function"), label: z.string() }).strict(),
  z.object({ ...nodeBase, kind: z.literal("branch"), label: z.string() }).strict(),
  z.object({ ...nodeBase, kind: z.literal("loop"), label: z.string() }).strict(),
  z.object({ ...nodeBase, kind: z.literal("effect"), label: z.string(), io: PortIO }).strict(),
  z.object({ ...nodeBase, kind: z.literal("const"), label: z.string(), value: z.unknown() }).strict(),
  // A module node is a hyperlink. Ports are DERIVED from modules[ref].ports.
  z.object({ ...nodeBase, kind: z.literal("module"), ref: z.string().min(1) }).strict(),
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
export type Port = z.infer<typeof Port>;
export type Node = z.infer<typeof Node>;
export type Wire = z.infer<typeof Wire>;
export type Interior = z.infer<typeof Interior>;
export type Module = z.infer<typeof Module>;
export type System = z.infer<typeof System>;
