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

describe("lift: classes (modules-as-methods + state-as-attributes)", () => {
  const SRC = [
    "export class Counter {",
    "  count: number;",
    "",
    "  increment(): void {",
    "    this.count = (this.count + 1);",
    "  }",
    "",
    "  current(): number {",
    "    return this.count;",
    "  }",
    "}",
    "",
  ].join("\n");

  it("lifts a class to a class module + method-link nodes + state cell", () => {
    const sys = liftTypeScript(SRC);
    expect(validateSystem(sys).ok).toBe(true);
    expect(sys.features).toEqual(["Counter"]);
    const cls = sys.modules["Counter"]!;
    expect(cls.kind).toBe("class");
    const kinds = cls.interior.nodes.map((n) => n.kind).sort();
    expect(kinds).toEqual(["module", "module", "state"]);
    // methods are their own navigable modules
    expect(sys.modules["Counter.increment"]).toBeDefined();
    expect(sys.modules["Counter.current"]).toBeDefined();
  });

  it("TS round-trip (transpile → lift → transpile) is a fixed point", () => {
    const codeA = transpile(liftTypeScript(SRC), "ts");
    const codeB = transpile(liftTypeScript(codeA), "ts");
    expect(codeB).toBe(codeA);
    expect(codeA).toContain("export class Counter {");
    expect(codeA).toContain("this.count = (this.count + 1);");
  });

  it("cross-compiles the same class IR to Python", () => {
    const py = transpile(liftTypeScript(SRC), "python");
    expect(py).toContain("class Counter:");
    expect(py).toContain("def increment(self) -> None:");
    expect(py).toContain("self.count = (self.count + 1)");
  });
});

describe.skipIf(!hasPython())("lift: classes (Python)", () => {
  const SRC = [
    "class Counter:",
    "    count: int",
    "",
    "    def increment(self) -> None:",
    "        self.count = (self.count + 1)",
    "",
    "    def current(self) -> int:",
    "        return self.count",
    "",
  ].join("\n");

  it("Python round-trip is a fixed point", () => {
    const codeA = transpile(liftPython(SRC), "python");
    expect(validateSystem(liftPython(codeA)).ok).toBe(true);
    const codeB = transpile(liftPython(codeA), "python");
    expect(codeB).toBe(codeA);
  });
});

describe("lift: template strings lower to the concat op", () => {
  const SRC = [
    "export function label(x: number): string {",
    "  return `value=${x}`;",
    "}",
    "",
  ].join("\n");

  it("lifts a template literal to a `concat` function node", () => {
    const sys = liftTypeScript(SRC);
    expect(validateSystem(sys).ok).toBe(true);
    const ops = sys.modules["label"]!.interior.nodes
      .filter((n) => n.kind === "function")
      .map((n) => (n as { op?: string }).op);
    expect(ops).toContain("concat");
  });

  it("TS round-trip (lift → transpile → lift → transpile) is a fixed point", () => {
    const codeA = transpile(liftTypeScript(SRC), "ts");
    expect(codeA).toContain('return ("value=" + x);');
    const codeB = transpile(liftTypeScript(codeA), "ts");
    expect(codeB).toBe(codeA);
  });

  it("cross-compiles the same IR to Python", () => {
    expect(transpile(liftTypeScript(SRC), "python")).toContain('return ("value=" + x)');
  });
});

describe("lift: control & collection constructs round-trip (TS)", () => {
  const cases: { name: string; src: string; expectA: string }[] = [
    {
      name: "while loop",
      src: "export function drain(n: number): void {\n  while ((n > 0)) {\n    console.log(n);\n  }\n}\n",
      expectA: "while ((n > 0)) {",
    },
    {
      name: "ternary → select",
      src: "export function pick(flag: boolean): number {\n  return (flag ? 1 : 0);\n}\n",
      expectA: "return (flag ? 1 : 0);",
    },
    {
      // Branch-arm returns normalize to a single `return select(...)`.
      name: "both-arm returns → select",
      src: 'export function classify(x: number): string {\n  if ((x < 0)) {\n    return "neg";\n  } else {\n    return "pos";\n  }\n}\n',
      expectA: 'return ((x < 0) ? "neg" : "pos");',
    },
    {
      // Reassignment is an SSA rebind; `n += 1; print(n)` collapses to `print(n + 1)`.
      name: "reassignment (n += 1)",
      src: "export function tick(n: number): void {\n  n += 1;\n  console.log(n);\n}\n",
      expectA: "console.log((n + 1));",
    },
    {
      name: "array literal",
      src: "export function makeList(): void {\n  const xs = [1, 2, 3];\n  console.log(xs);\n}\n",
      expectA: "console.log([1, 2, 3]);",
    },
    {
      // try/catch → a `try` node; the caught binding flows out as `error`.
      name: "try/catch → try node",
      src: "export function risky(n: number): void {\n  try {\n    console.log(n);\n  } catch (e) {\n    console.log(e);\n  }\n}\n",
      expectA: "} catch (e) {",
    },
    {
      // A guard clause: throw → a terminal `throw` node; the trailing statement
      // folds into the branch's surviving (else) arm, so the branch stays terminal.
      name: "throw guard → throw node",
      src: 'export function risky(n: number): void {\n  if ((n < 0)) {\n    throw new Error("negative");\n  }\n  console.log(n);\n}\n',
      expectA: 'throw new Error("negative");',
    },
  ];

  for (const { name, src, expectA } of cases) {
    it(`${name}: lifts, validates, and is a round-trip fixed point`, () => {
      const sys = liftTypeScript(src);
      expect(validateSystem(sys).ok).toBe(true);
      const codeA = transpile(sys, "ts");
      expect(codeA).toContain(expectA);
      const codeB = transpile(liftTypeScript(codeA), "ts");
      expect(codeB).toBe(codeA);
      // The same IR cross-compiles to Python without throwing.
      expect(() => transpile(sys, "python")).not.toThrow();
    });
  }
});

describe.skipIf(!hasPython())("lift: Python list comprehension", () => {
  const SRC = "def squares(n: int) -> None:\n    xs = [i * i for i in range(0, n + 1)]\n    print(xs)\n";

  it("lifts a comprehension and round-trips (Python)", () => {
    const sys = liftPython(SRC);
    expect(validateSystem(sys).ok).toBe(true);
    const codeA = transpile(sys, "python");
    expect(codeA).toContain("[(i * i) for i in range(0, n + 1)]");
    const codeB = transpile(liftPython(codeA), "python");
    expect(codeB).toBe(codeA);
  });
});

describe.skipIf(!hasPython())("lift: Python try/except", () => {
  const SRC = "def risky(n: int) -> None:\n    try:\n        print(n)\n    except Exception as e:\n        print(e)\n";

  it("lifts try/except → try node and round-trips (Python)", () => {
    const sys = liftPython(SRC);
    expect(validateSystem(sys).ok).toBe(true);
    const codeA = transpile(sys, "python");
    expect(codeA).toContain("except Exception as e:");
    const codeB = transpile(liftPython(codeA), "python");
    expect(codeB).toBe(codeA);
    // The same IR cross-compiles to a TS try/catch.
    expect(transpile(sys, "ts")).toContain("} catch (e) {");
  });
});

describe.skipIf(!hasPython())("lift: Python raise (throw)", () => {
  const SRC = "def risky(n: int) -> None:\n    if n < 0:\n        raise Exception(\"negative\")\n    print(n)\n";

  it("lifts raise → throw node and round-trips (Python)", () => {
    const sys = liftPython(SRC);
    expect(validateSystem(sys).ok).toBe(true);
    const codeA = transpile(sys, "python");
    expect(codeA).toContain('raise Exception("negative")');
    const codeB = transpile(liftPython(codeA), "python");
    expect(codeB).toBe(codeA);
    // The same IR cross-compiles to a TS throw.
    expect(transpile(sys, "ts")).toContain('throw new Error("negative");');
  });
});

describe("lift: rejects out-of-scope code (fails loudly, never lies)", () => {
  it("refuses re-raising a caught value (throw e) — only throw new Error(message) is modelled", () => {
    const src = [
      "export function risky(n: number): void {",
      "  try {",
      "    console.log(n);",
      "  } catch (e) {",
      "    throw e;",
      "  }",
      "}",
    ].join("\n");
    expect(() => liftTypeScript(src)).toThrow(/unsupported throw/);
  });

  it("refuses a post-branch merge (statements after a non-escaping branch)", () => {
    const src = [
      "export function f(n: number): void {",
      "  if ((n < 0)) {",
      "    console.log(0);",
      "  }",
      "  console.log(n);",
      "}",
    ].join("\n");
    expect(() => liftTypeScript(src)).toThrow(/control-flow merge/);
  });

  it("refuses try/finally (no IR node for finally)", () => {
    const src = [
      "export function risky(n: number): void {",
      "  try { console.log(n); } finally { console.log(0); }",
      "}",
    ].join("\n");
    expect(() => liftTypeScript(src)).toThrow(/try\/finally/);
  });

  it("still refuses a return in the middle of a function (non-tail)", () => {
    const src = [
      "export function f(x: number): number {",
      "  return x;",
      "  console.log(x);",
      "}",
    ].join("\n");
    expect(() => liftTypeScript(src)).toThrow(/early\/branch return/);
  });
});
