import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateSystem } from "../ir/index.js";
import { transpile } from "../transpile/index.js";
import { liftPython, liftTypeScript } from "./index.js";
import type { System } from "../ir/schema.js";

function load(name: string): System {
  const path = fileURLToPath(new URL(`../../examples/${name}`, import.meta.url));
  const result = validateSystem(JSON.parse(readFileSync(path, "utf8")));
  if (!result.ok) throw new Error(`example ${name} invalid`);
  return result.system;
}

function hasPython(): boolean {
  try { execFileSync("python3", ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
}

const EXAMPLES = ["fizzbuzz.kontur.json", "auth-search.kontur.json"];

/**
 * The headline property: lifting is the faithful inverse of transpiling for the
 * example-level subset. IR -> code -> IR' -> code' must be a fixed point.
 */
describe("lift: round-trip is a fixed point (TS)", () => {
  for (const ex of EXAMPLES) {
    it(`${ex}: transpile → lift → transpile is identical`, () => {
      const codeA = transpile(load(ex), "ts");
      const lifted = liftTypeScript(codeA);
      expect(validateSystem(lifted).ok).toBe(true);
      const codeB = transpile(lifted, "ts");
      expect(codeB).toBe(codeA);
    });
  }
});

describe.skipIf(!hasPython())("lift: round-trip is a fixed point (Python)", () => {
  for (const ex of EXAMPLES) {
    it(`${ex}: transpile → lift → transpile is identical`, () => {
      const codeA = transpile(load(ex), "python");
      const lifted = liftPython(codeA);
      expect(validateSystem(lifted).ok).toBe(true);
      const codeB = transpile(lifted, "python");
      expect(codeB).toBe(codeA);
    });
  }
});

describe("lift: imports hand-written code", () => {
  it("lifts a fresh TS function the transpiler never produced", () => {
    const src = [
      "export function countup(n: number): void {",
      "  for (let i = 1; i <= n; i++) {",
      "    console.log(i);",
      "  }",
      "}",
      "",
    ].join("\n");
    const lifted = liftTypeScript(src);
    expect(validateSystem(lifted).ok).toBe(true);
    // cross-compiles to Python from the same lifted IR
    expect(transpile(lifted, "python")).toContain("for i in range(1, n + 1):");
  });
});

describe("lift: rejects out-of-scope code (fails loudly, never lies)", () => {
  it("refuses early/branch returns", () => {
    const src = [
      "export function classify(x: number): string {",
      "  if ((x < 0)) { return \"neg\"; } else { return \"pos\"; }",
      "}",
    ].join("\n");
    expect(() => liftTypeScript(src)).toThrow(/early\/branch return/);
  });
});
