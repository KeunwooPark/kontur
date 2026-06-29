/**
 * Pin derivation — the renderer's analogue of what the compiler does implicitly.
 *
 * The IR does NOT declare a node's pins (its connection points). They are
 * implied: by the node kind's pin conventions, by the wires that touch it, and
 * — for a `module` node — by the referenced module's contract. To draw a node
 * we must recover that pin set.
 *
 * Strategy (faithful + total):
 *  - `module` node: pins are EXACTLY the referenced module's ports (issue #5 —
 *    the contract is derived, never restated). Drawing the full contract makes
 *    a link's boundary visible even for ports a caller happens not to wire.
 *  - every other node: pins are recovered from the wires that reference it. A
 *    bare `nodeId` endpoint is the node's *default* pin for that (io, wire);
 *    `nodeId:pin` is a named pin. This shows exactly what is connected.
 *
 * A pin is keyed by (io, wire, name) so a node's default-in-data,
 * default-in-control, default-out-data… coexist without collision.
 */
import type { Node, System, WireKind, PortIO } from "../ir/schema.js";
import { parseEndpoint } from "../ir/endpoint.js";

/** One connection point on a node. `name` is "" for an endpoint's default pin. */
export interface Pin {
  /** Stable key within the owning node: `${io}|${wire}|${name}`. */
  key: string;
  name: string;
  io: PortIO;
  wire: WireKind;
  /** Type label, known only for module-contract pins (issue #3 is still open). */
  type?: string;
}

export function pinKey(io: PortIO, wire: WireKind, name: string): string {
  return `${io}|${wire}|${name}`;
}

/** ELK/SVG-stable port id for a node pin. */
export function portId(nodeId: string, pin: { io: PortIO; wire: WireKind; name: string }): string {
  return `${nodeId}##${pinKey(pin.io, pin.wire, pin.name)}`;
}

/** Port id for a module-boundary port (the `P:name` endpoints). */
export function boundaryPortId(portName: string): string {
  return `bnd##${portName}`;
}

/**
 * The port id an endpoint string resolves to, plus the implied pin descriptor.
 * `role` says which side of the wire the endpoint sits on (a `from` is a source
 * → an OUT pin; a `to` is a target → an IN pin). Boundary endpoints return a
 * boundary port id and no node pin.
 */
export function endpointTarget(
  raw: string,
  role: "from" | "to",
): { portId: string; nodeId?: string; pin?: { io: PortIO; wire: WireKind; name: string } } {
  const ep = parseEndpoint(raw);
  if (ep.kind === "boundary") {
    return { portId: boundaryPortId(ep.port) };
  }
  const io: PortIO = role === "from" ? "out" : "in";
  // wire kind is supplied by the caller via the surrounding wire; encoded later.
  return { portId: ep.nodeId, nodeId: ep.nodeId, pin: { io, wire: "data", name: ep.port ?? "" } };
}

/**
 * Recover the ordered pin set of every interior node of a module. Returns a map
 * nodeId → pins. `module` nodes get the referenced contract; all others get the
 * pins implied by the wires touching them.
 */
export function derivePins(modId: string, system: System): Map<string, Pin[]> {
  const mod = system.modules[modId];
  if (!mod) return new Map();

  const byNode = new Map<string, Map<string, Pin>>();
  const ensure = (nodeId: string) => {
    let m = byNode.get(nodeId);
    if (!m) byNode.set(nodeId, (m = new Map()));
    return m;
  };
  const add = (nodeId: string, io: PortIO, wire: WireKind, name: string, type?: string) => {
    const m = ensure(nodeId);
    const key = pinKey(io, wire, name);
    const existing = m.get(key);
    if (existing) {
      if (type && !existing.type) existing.type = type;
      return;
    }
    m.set(key, { key, name, io, wire, ...(type !== undefined ? { type } : {}) });
  };

  const nodeById = new Map<string, Node>();
  for (const node of mod.interior.nodes) {
    nodeById.set(node.id, node);
    ensure(node.id); // every node exists even if wire-less (e.g. unused const)
    if (node.kind === "module") {
      const target = system.modules[node.ref];
      if (target) for (const p of target.ports) add(node.id, p.io, p.wire, p.name, p.type);
    }
  }

  for (const [from, to, kind] of mod.interior.wires) {
    const f = parseEndpoint(from);
    if (f.kind === "node" && nodeById.has(f.nodeId)) {
      // Module pins come from the contract; don't let a wire invent one.
      if (nodeById.get(f.nodeId)!.kind !== "module") add(f.nodeId, "out", kind, f.port ?? "");
    }
    const t = parseEndpoint(to);
    if (t.kind === "node" && nodeById.has(t.nodeId)) {
      if (nodeById.get(t.nodeId)!.kind !== "module") add(t.nodeId, "in", kind, t.port ?? "");
    }
  }

  // Order pins for stable layout: inputs before outputs, control before data,
  // then by name — gives a predictable, auditable port arrangement.
  const result = new Map<string, Pin[]>();
  for (const [nodeId, pins] of byNode) {
    result.set(nodeId, [...pins.values()].sort(comparePins));
  }
  return result;
}

const IO_RANK: Record<PortIO, number> = { in: 0, out: 1 };
const WIRE_RANK: Record<WireKind, number> = { control: 0, data: 1 };

function comparePins(a: Pin, b: Pin): number {
  return (
    IO_RANK[a.io] - IO_RANK[b.io] ||
    WIRE_RANK[a.wire] - WIRE_RANK[b.wire] ||
    a.name.localeCompare(b.name)
  );
}
