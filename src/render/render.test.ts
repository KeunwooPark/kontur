import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateSystem } from "../ir/index.js";
import type { System } from "../ir/schema.js";
import { liftTypeScript } from "../lift/index.js";
import { layoutModule, layoutSystem, render, renderCanvasSvg, renderNavigator } from "./index.js";
import { ink } from "./theme.js";
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

  it("carries a resolved method call's ref through layout and marks it a link in SVG", async () => {
    const src = [
      "class Session {",
      "  get(u: string): number {",
      "    return this.request(u);",
      "  }",
      "  request(u: string): number {",
      "    return u.length;",
      "  }",
      "}",
      "",
    ].join("\n");
    const res = validateSystem(liftTypeScript(src));
    if (!res.ok) throw new Error("lifted IR invalid");
    const canvas = await layoutModule("Session.get", res.system);
    const call = canvas.nodes.find((n) => n.kind === "method");
    // The self-method call resolves to Session.request, and layout keeps the ref…
    expect(call?.ref).toBe("Session.request");
    // …so the SVG draws it as a navigable link (data-link + node-link class).
    const svg = renderCanvasSvg(canvas, ink);
    expect(svg).toContain('data-link="Session.request"');
  });
});

describe("external (package) calls are rendered as boundary crossings", () => {
  const SRC = [
    'import { chunk } from "lodash";',
    'import * as path from "path";',
    "",
    "export function group(items: number[]): void {",
    "  const groups = chunk(items, 2);",
    '  const p = path.join("a", "b");',
    "  console.log(groups);",
    "  console.log(p);",
    "}",
    "",
  ].join("\n");

  function lift(): System {
    const res = validateSystem(liftTypeScript(SRC));
    if (!res.ok) throw new Error("lifted IR invalid");
    return res.system;
  }

  it("carries each call's package through layout onto the node", async () => {
    const sys = lift();
    const canvas = await layoutModule("group", sys);
    const externals = canvas.nodes.filter((n) => n.source !== undefined);
    expect(externals.map((n) => n.source).sort()).toEqual(["lodash", "path"]);
    // the dotted member call keeps its full label
    expect(externals.some((n) => n.label === "path.join" && n.source === "path")).toBe(true);
  });

  it("marks the node in SVG (dashed body, package name, data-source hook)", async () => {
    const sys = lift();
    const svg = renderCanvasSvg(await layoutModule("group", sys));
    expect(svg).toContain('data-source="lodash"');
    expect(svg).toContain('class="node node-external"');
    expect(svg).toContain("stroke-dasharray=\"4 3\""); // the boundary-crossing dashes
    // the package is named on the node body, not just in a tooltip
    expect(svg).toContain(">lodash<");
    expect(svg).toContain(">path<");
  });

  it("lists the imports in the Dependencies sidebar of the HTML bundle", async () => {
    const html = await render(lift());
    expect(html).toContain("Dependencies");
    expect(html).toContain("lodash");
    expect(html).toContain("chunk"); // the named binding summary
    expect(html).toContain("∗ path"); // the namespace binding summary
    expect(html).toContain("external — package call"); // legend entry
    expect(html).not.toContain("NaN");
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

describe("roots-first navigator (renderNavigator)", () => {
  it("roots the nav on the link graph, not files, and embeds every canvas", async () => {
    const sys = load("auth-search.kontur.json"); // login & search both link to userLookup
    const html = await renderNavigator(sys);
    // a self-contained navigator shell
    expect(html).toContain("system roots");
    expect(html).toContain("Click a ▸ box in the canvas");
    // ROOTS are modules nothing links into: login/search are roots, userLookup is NOT
    const roots = JSON.parse(html.match(/ROOTS=(\[[^\]]*\])/)![1]!);
    expect(roots).toContain("login");
    expect(roots).toContain("search");
    expect(roots).not.toContain("userLookup"); // it has incoming links
    // every module's canvas is embedded, keyed by id, with the link boxes live
    for (const id of Object.keys(sys.modules)) expect(html).toContain(JSON.stringify(id));
    expect(html).toContain("data-link"); // canvas link boxes navigable client-side
    // fully offline, no NaN geometry
    expect(html).not.toMatch(/<(script|link|img)[^>]*\s(src|href)="https?:/i);
    expect(html).not.toContain("NaN");
  });

  it("themes the shell from the passed theme (paper vs ink)", async () => {
    const sys = load("fizzbuzz.kontur.json");
    const [paperHtml, inkHtml] = await Promise.all([renderNavigator(sys), renderNavigator(sys, ink)]);
    expect(paperHtml).toContain(`--bg:#ffffff`);
    expect(inkHtml).toContain(`--bg:${ink.bg}`);
    expect(inkHtml).not.toContain(`--bg:#ffffff`);
  });

  it("is deterministic", async () => {
    const sys = load("auth-search.kontur.json");
    const [a, b] = await Promise.all([renderNavigator(sys), renderNavigator(sys)]);
    expect(a).toBe(b);
  });
});
