/**
 * Auto-layout for one canvas (Issue #1) via elkjs `layered` (Sugiyama).
 *
 * One module's interior → one ELK graph → absolute-positioned geometry. The app
 * shell renders one canvas at a time; this function is pure per module.
 *
 * Modeling choices:
 *  - Direction RIGHT: inputs enter on the left, outputs leave on the right, so
 *    the control "spine" reads left→right like the transpiled code.
 *  - Module-boundary ports become real nodes pinned to the FIRST (inputs) or
 *    LAST (outputs) layer. ELK's own graph-ports crash on hierarchy edges; this
 *    is both robust and lets us reserve space for boundary labels.
 *  - Control wires get higher priority so the execution spine routes straight;
 *    data wires are secondary, exactly as the manifesto prescribes.
 */
import ELK from "elkjs/lib/elk.bundled.js";
import type { ElkNode, ElkExtendedEdge, ElkPort } from "elkjs/lib/elk-api.js";
import type { System, WireKind, PortIO } from "../ir/schema.js";
import { parseEndpoint } from "../ir/endpoint.js";
import { derivePins, portId, boundaryPortId, pinKey, type Pin } from "./ports.js";

// --- output geometry -------------------------------------------------------

export type NodeKind =
  | "function" | "method" | "branch" | "loop" | "while" | "foreach" | "try" | "throw" | "rethrow" | "effect" | "const" | "module"
  | "select" | "array" | "comprehension" | "itercomp"
  | "state" | "stateGet" | "stateSet" | "attrGet"
  | "boundary";

export interface LaidOutPort {
  id: string;
  name: string;
  io: PortIO;
  wire: WireKind;
  type?: string;
  /** Absolute centre of the port marker. */
  x: number;
  y: number;
}

export interface LaidOutNode {
  id: string;
  kind: NodeKind;
  /** Display label (node label, const value, or module title). */
  label: string;
  sublabel?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  ports: LaidOutPort[];
  /** For module nodes: the module this links to (drives navigation). */
  ref?: string;
  /** For boundary nodes: which side of the contract this represents. */
  boundaryIo?: PortIO;
  /** For external (package) calls: the package the call crosses into. */
  source?: string;
}

export interface LaidOutEdge {
  id: string;
  wire: WireKind;
  points: { x: number; y: number }[];
}

export interface CanvasLayout {
  moduleId: string;
  title: string;
  width: number;
  height: number;
  nodes: LaidOutNode[];
  edges: LaidOutEdge[];
}

// --- sizing ---------------------------------------------------------------

const CHAR_W = 6.6; // approx px per char at the node-label font size
const PIN_GAP = 18;
const MIN_W = 76;
const MIN_H = 38;
const PAD_X = 16;
const PAD_Y = 12;
const PORT_BOX = 7;

function textW(s: string): number {
  return s.length * CHAR_W;
}

function sizeNode(label: string, pins: Pin[], sublabel?: string): { w: number; h: number } {
  const ins = pins.filter((p) => p.io === "in");
  const outs = pins.filter((p) => p.io === "out");
  const longestIn = Math.max(0, ...ins.map((p) => textW(p.name)));
  const longestOut = Math.max(0, ...outs.map((p) => textW(p.name)));
  // A sub-line (the package, for external calls) sits under the label; reserve a
  // little width for it and a second line of height so it never overruns.
  const subW = sublabel ? textW(sublabel) + PAD_X * 2 : 0;
  const w = Math.max(
    MIN_W,
    textW(label) + PAD_X * 2,
    subW,
    longestIn + longestOut + PAD_X * 2 + 18,
  );
  const h = Math.max(MIN_H, Math.max(ins.length, outs.length) * PIN_GAP + PAD_Y * 2) + (sublabel ? 13 : 0);
  return { w: Math.round(w), h: Math.round(h) };
}

/** The package an external call crosses into, or undefined for any other node. */
function nodeSource(node: System["modules"][string]["interior"]["nodes"][number]): string | undefined {
  return node.kind === "function" ? node.source : undefined;
}

// --- ELK graph construction ----------------------------------------------

const elk = new ELK();

const GRAPH_OPTIONS: Record<string, string> = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.layered.spacing.nodeNodeBetweenLayers": "56",
  "elk.spacing.nodeNode": "26",
  "elk.spacing.edgeNode": "16",
  "elk.spacing.portPort": "12",
  "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
  "elk.padding": "[top=24,left=24,bottom=24,right=24]",
  "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
};

const sideFor = (io: PortIO): string => (io === "in" ? "WEST" : "EAST");

export async function layoutModule(moduleId: string, system: System): Promise<CanvasLayout> {
  const mod = system.modules[moduleId];
  if (!mod) throw new Error(`layoutModule: unknown module "${moduleId}"`);

  const pinsByNode = derivePins(moduleId, system);

  // Ensure every wired endpoint has a backing pin (renderer stays total even on
  // a contract-violating-but-structurally-valid edge).
  const ensurePin = (nodeId: string, io: PortIO, wire: WireKind, name: string) => {
    const pins = pinsByNode.get(nodeId);
    if (!pins) return;
    const key = pinKey(io, wire, name);
    if (!pins.some((p) => p.key === key)) pins.push({ key, name, io, wire });
  };
  for (const [from, to, kind] of mod.interior.wires) {
    const f = parseEndpoint(from);
    if (f.kind === "node" && pinsByNode.has(f.nodeId)) ensurePin(f.nodeId, "out", kind, f.port ?? "");
    const t = parseEndpoint(to);
    if (t.kind === "node" && pinsByNode.has(t.nodeId)) ensurePin(t.nodeId, "in", kind, t.port ?? "");
  }

  // pin descriptor lookup for reading geometry back.
  const pinInfo = new Map<string, Pin & { nodeId: string }>();
  const children: ElkNode[] = [];

  for (const node of mod.interior.nodes) {
    const pins = pinsByNode.get(node.id) ?? [];
    const label = nodeLabel(node, system);
    const { w, h } = sizeNode(label, pins, nodeSource(node));
    const elkPorts: ElkPort[] = pins.map((p) => {
      const id = portId(node.id, p);
      pinInfo.set(id, { ...p, nodeId: node.id });
      return {
        id,
        width: PORT_BOX,
        height: PORT_BOX,
        layoutOptions: { "port.side": sideFor(p.io) },
      };
    });
    children.push({
      id: node.id,
      width: w,
      height: h,
      layoutOptions: { "elk.portConstraints": "FIXED_SIDE" },
      ports: elkPorts,
    });
  }

  // Boundary ports → pinned nodes (inputs FIRST layer, outputs LAST).
  for (const port of mod.ports) {
    const bid = `bnode##${port.name}`;
    const pid = boundaryPortId(port.name);
    const label = `${port.name}: ${port.type}`;
    pinInfo.set(pid, {
      key: pinKey(port.io, port.wire, port.name),
      name: port.name,
      io: port.io,
      wire: port.wire,
      type: port.type,
      nodeId: bid,
    });
    children.push({
      id: bid,
      width: Math.max(40, Math.round(textW(label)) + 18),
      height: 26,
      layoutOptions: {
        "elk.portConstraints": "FIXED_SIDE",
        "elk.layered.layering.layerConstraint": port.io === "in" ? "FIRST" : "LAST",
      },
      // an in-boundary feeds the interior (emits east); an out-boundary sinks (west).
      ports: [{ id: pid, width: PORT_BOX, height: PORT_BOX, layoutOptions: { "port.side": port.io === "in" ? "EAST" : "WEST" } }],
    });
  }

  const edges: ElkExtendedEdge[] = [];
  const edgeKind = new Map<string, WireKind>();
  mod.interior.wires.forEach(([from, to, kind], i) => {
    const id = `e${i}`;
    edgeKind.set(id, kind);
    edges.push({
      id,
      sources: [resolvePortId(from, "from", kind)],
      targets: [resolvePortId(to, "to", kind)],
      layoutOptions: { "elk.priority": kind === "control" ? "10" : "1" },
    });
  });

  const graph: ElkNode = { id: "root", layoutOptions: GRAPH_OPTIONS, children, edges };
  const laid = await elk.layout(graph);

  return readBack(moduleId, mod.title, laid, system, pinInfo, edgeKind);
}

function resolvePortId(raw: string, role: "from" | "to", kind: WireKind): string {
  const ep = parseEndpoint(raw);
  if (ep.kind === "boundary") return boundaryPortId(ep.port);
  const io: PortIO = role === "from" ? "out" : "in";
  return portId(ep.nodeId, { io, wire: kind, name: ep.port ?? "" });
}

function readBack(
  moduleId: string,
  title: string,
  laid: ElkNode,
  system: System,
  pinInfo: Map<string, Pin & { nodeId: string }>,
  edgeKind: Map<string, WireKind>,
): CanvasLayout {
  const irNodeKind = new Map<string, string>();
  const irNodeRef = new Map<string, string>();
  const mod = system.modules[moduleId]!;
  for (const n of mod.interior.nodes) {
    irNodeKind.set(n.id, n.kind);
    if (n.kind === "module") irNodeRef.set(n.id, n.ref);
  }

  const nodes: LaidOutNode[] = [];
  for (const child of laid.children ?? []) {
    const ax = child.x ?? 0;
    const ay = child.y ?? 0;
    const ports: LaidOutPort[] = (child.ports ?? []).map((p) => {
      const info = pinInfo.get(p.id);
      return {
        id: p.id,
        name: info?.name ?? "",
        io: info?.io ?? "in",
        wire: info?.wire ?? "data",
        ...(info?.type !== undefined ? { type: info.type } : {}),
        x: ax + (p.x ?? 0) + (p.width ?? 0) / 2,
        y: ay + (p.y ?? 0) + (p.height ?? 0) / 2,
      };
    });

    if (child.id.startsWith("bnode##")) {
      const portName = child.id.slice("bnode##".length);
      const contract = mod.ports.find((p) => p.name === portName)!;
      nodes.push({
        id: child.id,
        kind: "boundary",
        label: portName,
        sublabel: contract.type,
        boundaryIo: contract.io,
        x: ax,
        y: ay,
        w: child.width ?? 0,
        h: child.height ?? 0,
        ports,
      });
      continue;
    }

    const kind = (irNodeKind.get(child.id) ?? "function") as NodeKind;
    const irNode = mod.interior.nodes.find((n) => n.id === child.id)!;
    const ref = irNodeRef.get(child.id);
    const source = nodeSource(irNode);
    nodes.push({
      id: child.id,
      kind,
      label: nodeLabel(irNode, system),
      ...(ref !== undefined ? { ref } : {}),
      ...(source !== undefined ? { source } : {}),
      x: ax,
      y: ay,
      w: child.width ?? 0,
      h: child.height ?? 0,
      ports,
    });
  }

  const edges: LaidOutEdge[] = [];
  for (const e of laid.edges ?? []) {
    const wire = edgeKind.get(e.id) ?? "data";
    const points: { x: number; y: number }[] = [];
    for (const s of e.sections ?? []) {
      points.push(s.startPoint);
      for (const b of s.bendPoints ?? []) points.push(b);
      points.push(s.endPoint);
    }
    if (points.length >= 2) edges.push({ id: e.id, wire, points });
  }

  return {
    moduleId,
    title,
    width: Math.ceil(laid.width ?? 0),
    height: Math.ceil(laid.height ?? 0),
    nodes,
    edges,
  };
}

/** Human-facing label for a node. */
function nodeLabel(node: System["modules"][string]["interior"]["nodes"][number], system: System): string {
  switch (node.kind) {
    case "const":
      return typeof node.value === "string" ? JSON.stringify(node.value) : String(node.value);
    case "module":
      return system.modules[node.ref]?.title ?? node.ref;
    case "try":
      // `label` holds the catch binding; surface it as `try (e)` for the reader.
      return node.label ? `try (${node.label})` : "try";
    default:
      return node.label;
  }
}
