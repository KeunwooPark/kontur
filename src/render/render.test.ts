import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateSystem } from "../ir/index.js";
import type { System } from "../ir/schema.js";
import { layoutModule, layoutSystem, render } from "./index.js";
import { derivePins } from "./ports.js";

function load(name: string): System {
  const path = fileURLToPath(new URL(`../../examples/${name}`, import.meta.url));
  const result = validateSystem(JSON.parse(readFileSync(path, "utf8")));
  if (!result.ok) throw new Error(`example ${name} is invalid: ${JSON.stringify(result.issues)}`);
  return result.system;
}

const finite = (n: number) => Number.isFinite(n);

describe("pin derivation", () => {
  it("recovers a module node's pins from the referenced contract (issue #5)", () => {
    const sys = load("auth-search.kontur.json");
    const pins = derivePins("login", sys).get("ul")!; // the userLookup link
    const contract = sys.modules.userLookup!.ports;
    // every contract port shows as a pin, with name/io/wire preserved
    for (const p of contract) {
      expect(pins.some((q) => q.name === p.name && q.io === p.io && q.wire === p.wire)).toBe(true);
    }
    expect(pins).toHaveLength(contract.length);
  });

  it("recovers leaf-node pins from the wires touching them", () => {
    const sys = load("fizzbuzz.kontur.json");
    const pins = derivePins("fizzbuzz", sys);
    // a binary op function reads pins "a" and "b" and produces a default out
    const m15 = pins.get("m15")!;
    expect(m15.some((p) => p.io === "in" && p.wire === "data" && p.name === "a")).toBe(true);
    expect(m15.some((p) => p.io === "in" && p.wire === "data" && p.name === "b")).toBe(true);
    expect(m15.some((p) => p.io === "out" && p.wire === "data" && p.name === "")).toBe(true);
    // a branch reads cond (data in) + control in, and forks then/else (control out)
    const bFB = pins.get("bFB")!;
    expect(bFB.some((p) => p.io === "in" && p.wire === "data" && p.name === "cond")).toBe(true);
    expect(bFB.some((p) => p.io === "out" && p.wire === "control" && p.name === "then")).toBe(true);
    expect(bFB.some((p) => p.io === "out" && p.wire === "control" && p.name === "else")).toBe(true);
  });
});

describe("layout", () => {
  for (const name of ["fizzbuzz.kontur.json", "auth-search.kontur.json"]) {
    it(`produces finite geometry for every node and wire of ${name}`, async () => {
      const sys = load(name);
      for (const [modId, mod] of Object.entries(sys.modules)) {
        const canvas = await layoutModule(modId, sys);
        expect(canvas.width).toBeGreaterThan(0);
        expect(canvas.height).toBeGreaterThan(0);

        for (const node of canvas.nodes) {
          for (const v of [node.x, node.y, node.w, node.h]) expect(finite(v)).toBe(true);
          for (const port of node.ports) expect(finite(port.x) && finite(port.y)).toBe(true);
        }

        // every interior wire becomes a routed edge with at least two points
        expect(canvas.edges).toHaveLength(mod.interior.wires.length);
        for (const e of canvas.edges) {
          expect(e.points.length).toBeGreaterThanOrEqual(2);
          for (const pt of e.points) expect(finite(pt.x) && finite(pt.y)).toBe(true);
        }

        // port-boundary invariant is visible: one boundary node per contract port
        const boundary = canvas.nodes.filter((n) => n.kind === "boundary");
        expect(boundary).toHaveLength(mod.ports.length);
      }
    });
  }

  it("lays out one canvas per module", async () => {
    const sys = load("auth-search.kontur.json");
    const canvases = await layoutSystem(sys);
    expect(canvases.map((c) => c.moduleId).sort()).toEqual(Object.keys(sys.modules).sort());
  });

  it("renders a module node as a navigable link to its target", async () => {
    const sys = load("auth-search.kontur.json");
    const login = await layoutModule("login", sys);
    const link = login.nodes.find((n) => n.kind === "module");
    expect(link?.ref).toBe("userLookup");
  });
});

describe("html bundle", () => {
  it("is self-contained and embeds every canvas", async () => {
    const sys = load("auth-search.kontur.json");
    const html = await render(sys);

    // a canvas section per module
    for (const id of Object.keys(sys.modules)) {
      expect(html).toContain(`data-module="${id}"`);
    }
    // feature entry points and titles present
    expect(html).toContain("User Lookup");
    expect(html).toContain('"features":["login","search"]');

    // the shared module is a hyperlink from BOTH callers
    expect(html.match(/data-link="userLookup"/g)?.length).toBe(2);

    // no external resources — fully offline
    expect(html).not.toMatch(/<(script|link|img)[^>]*\s(src|href)="https?:/i);
    expect(html).not.toContain("NaN");
  });

  it("is deterministic", async () => {
    const sys = load("fizzbuzz.kontur.json");
    const [a, b] = await Promise.all([render(sys), render(sys)]);
    expect(a).toBe(b);
  });
});
