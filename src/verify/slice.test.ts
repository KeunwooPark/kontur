import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { liftPython, liftTypeScript } from "../lift/index.js";
import { extractSlice, renderVerificationPrompt, verifySystem, type Verifier } from "./index.js";
import type { System } from "../ir/schema.js";

function hasPython(): boolean {
  try { execFileSync("python3", ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
}

/** Find the single node of a given kind in a module. */
function nodeOf(sys: System, moduleId: string, kind: string): string {
  const n = sys.modules[moduleId]!.interior.nodes.find((x) => x.kind === kind);
  if (!n) throw new Error(`no ${kind} node in ${moduleId}`);
  return n.id;
}

describe("verify: slice extraction (structural, no provenance needed)", () => {
  // TS lift carries no source spans yet, so this exercises the dependency
  // closure purely from wires: reads, upstream statements, and call contracts.
  const SRC = [
    "function helper(a: number): number {",
    "  return (a + 1);",
    "}",
    "function main(x: number): void {",
    "  const r = helper(x);",
    "  console.log(r);",
    "}",
    "",
  ].join("\n");

  it("a call's slice reports the parameter it reads and the callee's contract", () => {
    const sys = liftTypeScript(SRC);
    const callNode = "r"; // the `helper(x)` module node is id-hinted to its let name
    const slice = extractSlice(sys, "main", callNode);
    expect(slice.target.kind).toBe("module");
    expect(slice.reads.map((p) => p.name)).toEqual(["x"]);
    expect(slice.calls.map((c) => c.ref)).toEqual(["helper"]);
  });

  it("a print's slice names the upstream statement it consumes (not the raw param)", () => {
    const sys = liftTypeScript(SRC);
    const printNode = nodeOf(sys, "main", "effect");
    const slice = extractSlice(sys, "main", printNode);
    // It consumes `r` (a sequenced call), so `r` is upstream — the walk stops there
    // rather than diving past it to `x`. That is the per-statement decomposition.
    expect(slice.upstream.map((u) => u.id)).toEqual(["r"]);
    expect(slice.calls.map((c) => c.ref)).toEqual(["helper"]);
    expect(slice.reads).toEqual([]);
  });
});

describe.skipIf(!hasPython())("verify: slice resolves to source via provenance (Python)", () => {
  const SRC = [
    "def validate(qty: int) -> None:",
    "    if qty < 0:",
    '        raise ValueError("negative quantity")',
    "    print(qty)",
    "",
  ].join("\n");

  it("the print node's slice carries its source text and the param it reads", () => {
    const sys = liftPython(SRC);
    const printNode = nodeOf(sys, "validate", "effect");
    const slice = extractSlice(sys, "validate", printNode, SRC);
    expect(slice.target.source).toBe("print(qty)");
    expect(slice.reads).toEqual([{ name: "qty", type: "int" }]);
    // The rendered prompt is self-contained: signature + statement + inputs.
    const prompt = renderVerificationPrompt(slice);
    expect(prompt).toContain("Function: validate(qty: int)");
    expect(prompt).toContain("print(qty)");
    expect(prompt).toContain("qty: int  (parameter)");
  });

  it("a guarded statement carries its control context (the branch arm it runs in)", () => {
    const sys = liftPython(SRC);
    // The `raise` only runs inside the `then` arm of `if qty < 0:` — without that
    // control context it looks unconditional, which is the false-positive we fixed.
    const throwNode = nodeOf(sys, "validate", "throw");
    const slice = extractSlice(sys, "validate", throwNode, SRC);
    expect(slice.guards.length).toBe(1);
    expect(slice.guards[0]!.arm).toBe("then");
    expect(renderVerificationPrompt(slice)).toContain("the then arm of: if qty < 0:");
  });

  it("verifySystem fans out over every provenance-bearing node", async () => {
    const sys = liftPython(SRC);
    const verifier: Verifier = async () => ({ ok: true, reason: "stub" });
    const report = await verifySystem(sys, verifier, { source: SRC });
    // validate() has three provenance nodes: the branch, the throw, the print.
    expect(report.length).toBe(3);
    expect(report.every((r) => r.verdict.ok)).toBe(true);
  });
});

describe.skipIf(!hasPython())("verify: slice surfaces class-attribute reads (Python)", () => {
  const SRC = [
    "class Counter:",
    "    count: int",
    "",
    "    def increment(self) -> None:",
    "        self.count = self.count + 1",
    "        print(self.count)",
    "",
  ].join("\n");

  it("a statement reading self.count reports it as an attribute with its type", () => {
    const sys = liftPython(SRC);
    const printNode = nodeOf(sys, "Counter.increment", "effect");
    const slice = extractSlice(sys, "Counter.increment", printNode, SRC);
    expect(slice.state).toEqual([{ attr: "count", type: "int" }]);
    expect(renderVerificationPrompt(slice)).toContain("self.count: int  (attribute)");
  });
});
