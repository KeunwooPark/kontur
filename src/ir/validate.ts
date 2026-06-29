/**
 * Kontur IR — semantic validation.
 *
 * zod (schema.ts) guarantees shape. This module enforces everything zod can't
 * see across the document:
 *   - referential integrity (wire endpoints, module refs, feature ids resolve)
 *   - uniqueness (node ids, port names)
 *   - module-node ports addressed by wires actually exist on the referenced
 *     module's contract (so a link can't invent a port)
 *   - the PORT-BOUNDARY INVARIANT (strict, load-bearing): a module's declared
 *     ports correspond exactly to its interior boundary — same set, with each
 *     port wired on the correct side and with the matching wire kind.
 *
 * A bad IR must fail HERE, never later in the transpiler or renderer.
 */
import { System as SystemSchema } from "./schema.js";
import type { Module, System } from "./schema.js";
import { parseEndpoint } from "./endpoint.js";

export interface ValidationIssue {
  /** Dotted path into the document, best-effort. */
  path: string;
  message: string;
}

export type ValidationResult =
  | { ok: true; system: System }
  | { ok: false; issues: ValidationIssue[] };

/** Parse + structurally validate, then run all semantic checks. */
export function validateSystem(input: unknown): ValidationResult {
  const parsed = SystemSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    };
  }

  const system = parsed.data;
  const issues: ValidationIssue[] = [];

  // Features must point at real modules.
  for (const [i, feat] of system.features.entries()) {
    if (!(feat in system.modules)) {
      issues.push({
        path: `features.${i}`,
        message: `feature references unknown module "${feat}"`,
      });
    }
  }

  for (const [modId, mod] of Object.entries(system.modules)) {
    checkModule(modId, mod, system, issues);
  }

  return issues.length === 0 ? { ok: true, system } : { ok: false, issues };
}

function checkModule(
  modId: string,
  mod: Module,
  system: System,
  issues: ValidationIssue[],
): void {
  const at = `modules.${modId}`;

  // --- uniqueness -----------------------------------------------------------
  const portByName = new Map<string, (typeof mod.ports)[number]>();
  for (const [i, port] of mod.ports.entries()) {
    if (portByName.has(port.name)) {
      issues.push({ path: `${at}.ports.${i}`, message: `duplicate port name "${port.name}"` });
    }
    portByName.set(port.name, port);
  }

  const nodeById = new Map<string, (typeof mod.interior.nodes)[number]>();
  for (const [i, node] of mod.interior.nodes.entries()) {
    if (nodeById.has(node.id)) {
      issues.push({ path: `${at}.interior.nodes.${i}`, message: `duplicate node id "${node.id}"` });
    }
    nodeById.set(node.id, node);
  }

  // Module-node refs must resolve.
  for (const node of mod.interior.nodes) {
    if (node.kind === "module" && !(node.ref in system.modules)) {
      issues.push({
        path: `${at}.interior.nodes[${node.id}]`,
        message: `module node references unknown module "${node.ref}"`,
      });
    }
  }

  // --- class / state hygiene ------------------------------------------------
  // A class canvas is a namespace: only `state` cells and `module` links
  // (methods). State cells exist only on a class canvas; methods reach the
  // enclosing class's attributes through stateGet/stateSet, never `state`.
  const isClass = mod.kind === "class";
  for (const node of mod.interior.nodes) {
    if (isClass && node.kind !== "state" && node.kind !== "module") {
      issues.push({
        path: `${at}.interior.nodes[${node.id}]`,
        message: `class module may only contain "state" and "module" (method) nodes, not "${node.kind}"`,
      });
    }
    if (!isClass && node.kind === "state") {
      issues.push({
        path: `${at}.interior.nodes[${node.id}]`,
        message: `"state" node "${node.id}" is only allowed inside a class module`,
      });
    }
  }

  // --- wires + boundary invariant ------------------------------------------
  // Track, per declared port, which sides it was wired on so we can confirm
  // each port has exactly its correct boundary connection.
  const boundaryUseAsFrom = new Map<string, number>();
  const boundaryUseAsTo = new Map<string, number>();

  for (const [i, wire] of mod.interior.wires.entries()) {
    const wat = `${at}.interior.wires.${i}`;
    const [fromRaw, toRaw, kind] = wire;
    const from = parseEndpoint(fromRaw);
    const to = parseEndpoint(toRaw);

    // resolve `from`
    if (from.kind === "boundary") {
      const port = portByName.get(from.port);
      if (!port) {
        issues.push({ path: wat, message: `wire 'from' references unknown boundary port "${from.port}"` });
      } else {
        boundaryUseAsFrom.set(from.port, (boundaryUseAsFrom.get(from.port) ?? 0) + 1);
        if (port.wire !== kind) {
          issues.push({ path: wat, message: `wire kind "${kind}" does not match port "${port.name}" kind "${port.wire}"` });
        }
        if (port.io !== "in") {
          issues.push({ path: wat, message: `out-port "${port.name}" cannot be a wire source` });
        }
      }
    } else {
      resolveNodeEndpoint(from, "from", wat, nodeById, system, issues);
    }

    // resolve `to`
    if (to.kind === "boundary") {
      const port = portByName.get(to.port);
      if (!port) {
        issues.push({ path: wat, message: `wire 'to' references unknown boundary port "${to.port}"` });
      } else {
        boundaryUseAsTo.set(to.port, (boundaryUseAsTo.get(to.port) ?? 0) + 1);
        if (port.wire !== kind) {
          issues.push({ path: wat, message: `wire kind "${kind}" does not match port "${port.name}" kind "${port.wire}"` });
        }
        if (port.io !== "out") {
          issues.push({ path: wat, message: `in-port "${port.name}" cannot be a wire target` });
        }
      }
    } else {
      resolveNodeEndpoint(to, "to", wat, nodeById, system, issues);
    }
  }

  // The invariant: every declared port must be connected to the interior on its
  // correct side. An `in` port feeds the interior (appears as a source); an
  // `out` port is produced by the interior (appears as a target).
  for (const port of mod.ports) {
    if (port.io === "in" && !boundaryUseAsFrom.has(port.name)) {
      issues.push({
        path: `${at}.ports[${port.name}]`,
        message: `in-port "${port.name}" is not connected to the interior (port-boundary invariant)`,
      });
    }
    if (port.io === "out" && !boundaryUseAsTo.has(port.name)) {
      issues.push({
        path: `${at}.ports[${port.name}]`,
        message: `out-port "${port.name}" is not connected to the interior (port-boundary invariant)`,
      });
    }
  }
}

/** Resolve a node-targeted endpoint, validating module-node ports against the contract. */
function resolveNodeEndpoint(
  ep: { kind: "node"; nodeId: string; port: string | undefined },
  side: "from" | "to",
  wat: string,
  nodeById: Map<string, import("./schema.js").Node>,
  system: System,
  issues: ValidationIssue[],
): void {
  const node = nodeById.get(ep.nodeId);
  if (!node) {
    issues.push({ path: wat, message: `wire '${side}' references unknown node "${ep.nodeId}"` });
    return;
  }
  // For module nodes, a named port MUST exist on the referenced contract — this
  // is what makes a link's ports derived (issue #5) rather than free-form.
  if (node.kind === "module" && ep.port !== undefined) {
    const target = system.modules[node.ref];
    if (target && !target.ports.some((p) => p.name === ep.port)) {
      issues.push({
        path: wat,
        message: `module node "${ep.nodeId}" has no port "${ep.port}" on its contract (modules.${node.ref})`,
      });
    }
  }
}
