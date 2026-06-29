/**
 * Verification slice — the payoff of provenance.
 *
 * Given one IR node, extract the *minimal self-contained context* needed to
 * judge it: the node's own source, the enclosing function's signature, every
 * named value it (transitively) reads, the prior statements whose results feed
 * it, the control context that gates it (the branches/loops/try it sits inside),
 * the class attributes it reads, and the contracts of anything it calls. Hand
 * that slice to an LLM and it can verify a small, bounded piece of the program
 * instead of scanning the whole codebase — which is more reliable,
 * parallelizable, and *located* (a verdict points at an exact node and span).
 *
 * The dependency closure is read straight off the IR's data/control wires, so it
 * works for any backend. `prov` (set by the lifters) is what turns the closure
 * into readable *source*; without it the slice is still structurally correct,
 * just without code text.
 */
import type { Node, Port, SourceSpan, System } from "../ir/schema.js";
import { parseEndpoint } from "../ir/endpoint.js";

export interface SliceParam {
  name: string;
  type: string;
}

/** A class attribute the node reads (`self.attr` / `this.attr`). */
export interface StateRead {
  attr: string;
  type?: string;
}

/** A node in the slice, resolved back to its source where provenance exists. */
export interface SliceDef {
  id: string;
  kind: Node["kind"];
  label: string;
  prov?: SourceSpan;
  source?: string;
}

/** A control construct the target sits inside (the arm it executes under). */
export interface Guard extends SliceDef {
  /** Which arm gates the target: a branch `then`/`else`, a loop `body`, a try `catch`. */
  arm: string;
}

/** The public contract of a module the slice references (a called function). */
export interface CallContract {
  ref: string;
  title: string;
  ports: Port[];
}

export interface VerificationSlice {
  module: { id: string; title: string; kind: "function" | "class"; params: SliceParam[]; returns: SliceParam[] };
  /** The node under verification, with its source. */
  target: SliceDef;
  /** Control constructs that gate the target, outermost first. */
  guards: Guard[];
  /** Parameters the target transitively reads (with types). */
  reads: SliceParam[];
  /** Class attributes the target transitively reads. */
  state: StateRead[];
  /** Prior *sequenced* statements whose results feed the target. */
  upstream: SliceDef[];
  /** Contracts of modules the target (or its upstream) calls. */
  calls: CallContract[];
}

/** Resolve a source span to the text it covers. `line` 1-based, `col` 0-based. */
export function sliceSource(source: string | undefined, sp: SourceSpan | undefined): string | undefined {
  if (!source || !sp) return undefined;
  const lines = source.split("\n");
  if (sp.start.line === sp.end.line) return lines[sp.start.line - 1]?.slice(sp.start.col, sp.end.col);
  const out: string[] = [];
  for (let ln = sp.start.line; ln <= sp.end.line; ln++) {
    const line = lines[ln - 1] ?? "";
    if (ln === sp.start.line) out.push(line.slice(sp.start.col));
    else if (ln === sp.end.line) out.push(line.slice(0, sp.end.col));
    else out.push(line);
  }
  return out.join("\n");
}

function labelOf(n: Node): string {
  if (n.kind === "module") return `→${n.ref}`;
  return "label" in n && n.label ? n.label : n.kind;
}

/** The first non-empty line of a span's source (e.g. the `if …:` of a branch). */
function firstLine(text: string | undefined): string | undefined {
  return text?.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
}

export function extractSlice(system: System, moduleId: string, nodeId: string, source?: string): VerificationSlice {
  const mod = system.modules[moduleId];
  if (!mod) throw new Error(`verify: no module "${moduleId}"`);
  const nodes = new Map(mod.interior.nodes.map((n) => [n.id, n]));
  const target = nodes.get(nodeId);
  if (!target) throw new Error(`verify: no node "${nodeId}" in module "${moduleId}"`);

  // Wire indexes:
  //  - dataInto:    node id → upstream `from` endpoints feeding its data in-ports.
  //  - sequenced:   nodes that sit on the control wire (their own statement).
  //  - controlInto: node id → the single control-in `from` endpoint (its predecessor
  //                 in execution: a sibling, or a branch/loop/try arm that gates it).
  const dataInto = new Map<string, string[]>();
  const sequenced = new Set<string>();
  const controlInto = new Map<string, string>();
  for (const [from, to, kind] of mod.interior.wires) {
    const e = parseEndpoint(to);
    if (kind === "data" && e.kind === "node") {
      const arr = dataInto.get(e.nodeId) ?? [];
      arr.push(from);
      dataInto.set(e.nodeId, arr);
    } else if (kind === "control" && e.kind === "node" && e.port === undefined) {
      sequenced.add(e.nodeId);
      controlInto.set(e.nodeId, from);
    }
  }

  const inDataPorts = new Map(mod.ports.filter((p) => p.io === "in" && p.wire === "data").map((p) => [p.name, p.type]));

  // The class a method belongs to (for resolving attribute types). A method module
  // is keyed `Class.method`; its `state` cells live on the `Class` module.
  const dot = moduleId.indexOf(".");
  const classMod = dot > 0 ? system.modules[moduleId.slice(0, dot)] : undefined;
  const attrType = (attr: string): string | undefined => {
    const cell = classMod?.interior.nodes.find((n) => n.kind === "state" && n.label === attr);
    return cell && "type" in cell ? cell.type : undefined;
  };

  const toDef = (n: Node): SliceDef => {
    const src = sliceSource(source, n.prov);
    return {
      id: n.id,
      kind: n.kind,
      label: labelOf(n),
      ...(n.prov ? { prov: n.prov } : {}),
      ...(src !== undefined ? { source: src } : {}),
    };
  };

  const reads = new Map<string, SliceParam>();
  const state = new Map<string, StateRead>();
  const upstream = new Map<string, Node>();
  const calls = new Map<string, CallContract>();
  const seen = new Set<string>();

  const collectCall = (n: Node): void => {
    if (n.kind !== "module") return;
    const m = system.modules[n.ref];
    if (m && !calls.has(n.ref)) calls.set(n.ref, { ref: n.ref, title: m.title, ports: m.ports });
  };

  const walk = (fromEndpoint: string): void => {
    const e = parseEndpoint(fromEndpoint);
    if (e.kind === "boundary") {
      const type = inDataPorts.get(e.port);
      if (type !== undefined) reads.set(e.port, { name: e.port, type });
      return;
    }
    const n = nodes.get(e.nodeId);
    if (!n) return;
    collectCall(n);
    if (n.kind === "stateGet" && !state.has(n.attr)) {
      const t = attrType(n.attr);
      state.set(n.attr, t !== undefined ? { attr: n.attr, type: t } : { attr: n.attr });
    }
    if (n.id !== nodeId && sequenced.has(n.id)) {
      upstream.set(n.id, n); // a sibling statement whose result we consume — its own slice
      return;
    }
    if (seen.has(n.id)) return;
    seen.add(n.id);
    for (const up of dataInto.get(n.id) ?? []) walk(up);
  };

  collectCall(target);
  for (const up of dataInto.get(nodeId) ?? []) walk(up);

  // Control context: walk the control wire back to the function entry, collecting
  // every branch/loop/try arm the target executes inside.
  const guards: Guard[] = [];
  let cur: string | undefined = nodeId;
  const seenGuard = new Set<string>();
  while (cur !== undefined) {
    const from = controlInto.get(cur);
    if (from === undefined) break;
    const e = parseEndpoint(from);
    if (e.kind !== "node" || seenGuard.has(e.nodeId)) break;
    seenGuard.add(e.nodeId);
    const parent = nodes.get(e.nodeId);
    if (parent && (e.port === "then" || e.port === "else" || e.port === "body" || e.port === "catch")) {
      guards.push({ ...toDef(parent), arm: e.port });
    }
    cur = e.nodeId;
  }
  guards.reverse(); // outermost gate first

  return {
    module: {
      id: moduleId,
      title: mod.title,
      kind: mod.kind ?? "function",
      params: mod.ports.filter((p) => p.io === "in" && p.wire === "data").map((p) => ({ name: p.name, type: p.type })),
      returns: mod.ports.filter((p) => p.io === "out" && p.wire === "data").map((p) => ({ name: p.name, type: p.type })),
    },
    target: toDef(target),
    guards,
    reads: [...reads.values()],
    state: [...state.values()],
    upstream: [...upstream.values()].map(toDef),
    calls: [...calls.values()],
  };
}

/** Render a slice as a self-contained, LLM-ready verification prompt. */
export function renderVerificationPrompt(slice: VerificationSlice, intent?: string): string {
  const { module: m, target } = slice;
  const sig =
    `${m.id}(${m.params.map((p) => `${p.name}: ${p.type}`).join(", ")})` +
    (m.returns.length ? ` -> ${m.returns.map((r) => r.type).join(", ")}` : "");

  const out: string[] = [];
  out.push("You are verifying ONE statement of a function in isolation.");
  out.push("");
  out.push(`Function: ${sig}${m.kind === "class" ? "   (a method)" : ""}`);
  out.push("");
  out.push(`Statement under test  [node ${target.id}, kind=${target.kind}]:`);
  out.push(`    ${target.source ?? `(${target.label} — no source provenance)`}`);
  out.push("");
  out.push("Control context (this statement runs only inside):");
  out.push(
    slice.guards.length
      ? slice.guards.map((g) => `    the ${g.arm} arm of: ${firstLine(g.source) ?? g.label}`).join("\n")
      : "    (top level — always runs once control reaches it)",
  );
  out.push("");
  out.push("Names it reads:");
  const named = [
    ...slice.reads.map((r) => `    ${r.name}: ${r.type}  (parameter)`),
    ...slice.state.map((s) => `    self.${s.attr}${s.type ? `: ${s.type}` : ""}  (attribute)`),
  ];
  out.push(named.length ? named.join("\n") : "    (none)");
  out.push("");
  out.push("Prior statements it depends on:");
  out.push(
    slice.upstream.length
      ? slice.upstream.map((u) => `    [${u.id}] ${u.source ?? u.label}`).join("\n")
      : "    (none)",
  );
  out.push("");
  out.push("Functions it calls (contracts):");
  out.push(
    slice.calls.length
      ? slice.calls
          .map((c) => {
            const ins = c.ports.filter((p) => p.io === "in" && p.wire === "data").map((p) => `${p.name}: ${p.type}`);
            const outs = c.ports.filter((p) => p.io === "out" && p.wire === "data").map((p) => p.type);
            return `    ${c.ref}(${ins.join(", ")})${outs.length ? ` -> ${outs.join(", ")}` : ""}`;
          })
          .join("\n")
      : "    (none)",
  );
  out.push("");
  if (intent) {
    out.push(`Claimed intent of this statement: ${intent}`);
    out.push("");
  }
  out.push(
    "Question: using ONLY the information above, does the statement under test do " +
      "what its context implies? Reply with a verdict (ok / suspect) and a one-sentence reason.",
  );
  return out.join("\n");
}
