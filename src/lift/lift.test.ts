import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

describe("lift: package imports (capture + external call tagging)", () => {
  it("captures a named import, tags the call with its package, and round-trips (TS)", () => {
    const src = [
      'import { chunk } from "lodash";',
      "",
      "export function group(items: number[]): void {",
      "  const groups = chunk(items, 2);",
      "  console.log(groups);",
      "}",
      "",
    ].join("\n");

    const sys = liftTypeScript(src);
    expect(validateSystem(sys).ok).toBe(true);

    // Step 1: the import is recorded verbatim (was silently dropped before).
    expect(sys.imports).toEqual([
      { source: "lodash", bindings: [{ kind: "named", imported: "chunk", local: "chunk" }] },
    ]);
    // Step 2: the call into the package is a `function` node tagged with `source`.
    const ext = sys.modules["group"]!.interior.nodes.find(
      (n): n is Extract<typeof n, { kind: "function" }> => n.kind === "function" && "source" in n && n.source !== undefined,
    );
    expect(ext?.label).toBe("chunk");
    expect((ext as { source?: string }).source).toBe("lodash");

    const codeA = transpile(sys, "ts");
    // The import line comes back, and the API name is emitted VERBATIM (not re-cased).
    expect(codeA).toContain('import { chunk } from "lodash";');
    expect(codeA).toContain("const groups = chunk(items, 2);");
    // Round-trip is a fixed point.
    const codeB = transpile(liftTypeScript(codeA), "ts");
    expect(codeB).toBe(codeA);
  });

  it("captures a namespace import and preserves a dotted member call verbatim (TS)", () => {
    const src = [
      'import * as path from "path";',
      "",
      "export function where(): void {",
      '  const p = path.join("a", "b");',
      "  console.log(p);",
      "}",
      "",
    ].join("\n");

    const sys = liftTypeScript(src);
    expect(validateSystem(sys).ok).toBe(true);
    expect(sys.imports).toEqual([
      { source: "path", bindings: [{ kind: "namespace", local: "path" }] },
    ]);

    const codeA = transpile(sys, "ts");
    expect(codeA).toContain('import * as path from "path";');
    // `path.join` survives intact — camel-casing would have mangled it to `pathJoin`.
    expect(codeA).toContain('const p = path.join("a", "b");');
    const codeB = transpile(liftTypeScript(codeA), "ts");
    expect(codeB).toBe(codeA);
  });

  it("preserves an aliased named import across the round-trip (TS)", () => {
    const src = [
      'import { readFile as read } from "fs";',
      "",
      "export function load(name: string): void {",
      "  const data = read(name);",
      "  console.log(data);",
      "}",
      "",
    ].join("\n");
    const codeA = transpile(liftTypeScript(src), "ts");
    expect(codeA).toContain('import { readFile as read } from "fs";');
    expect(codeA).toContain("const data = read(name);");
    expect(transpile(liftTypeScript(codeA), "ts")).toBe(codeA);
  });

  it("refuses a type-only import (no runtime meaning, no IR model)", () => {
    const src = 'import type { User } from "./models";\nexport function f(): void {}\n';
    expect(() => liftTypeScript(src)).toThrow(/type-only import/);
  });

  it("refuses `import = require()` (only ES module imports are modelled)", () => {
    const src = 'import fs = require("fs");\nexport function f(): void {}\n';
    expect(() => liftTypeScript(src)).toThrow(/import = require/);
  });
});

describe.skipIf(!hasPython())("lift: package imports (Python)", () => {
  it("captures `from … import` + `import …`, tags calls, and round-trips", () => {
    const src = [
      "from math import sqrt",
      "import os",
      "",
      "",
      "def f(n: int) -> None:",
      "    x = sqrt(n)",
      "    y = os.getcwd()",
      "    print(x)",
      "    print(y)",
      "",
    ].join("\n");

    const sys = liftPython(src);
    expect(validateSystem(sys).ok).toBe(true);
    // Imports captured (provenance is stamped by the Python extractor).
    expect(sys.imports?.map((i) => ({ source: i.source, bindings: i.bindings }))).toEqual([
      { source: "math", bindings: [{ kind: "named", imported: "sqrt", local: "sqrt" }] },
      { source: "os", bindings: [{ kind: "namespace", local: "os" }] },
    ]);
    // `sqrt` and the namespace member call `os.getcwd` are tagged external.
    const tagged = sys.modules["f"]!.interior.nodes
      .filter((n) => n.kind === "function" && "source" in n && n.source !== undefined)
      .map((n) => (n as { label: string; source?: string }).source);
    expect(tagged.sort()).toEqual(["math", "os"]);

    const codeA = transpile(sys, "python");
    expect(codeA).toContain("from math import sqrt");
    expect(codeA).toContain("import os");
    expect(codeA).toContain("y = os.getcwd()"); // member call kept verbatim (not snake-cased)
    const codeB = transpile(liftPython(codeA), "python");
    expect(codeB).toBe(codeA);
  });

  it("captures package-relative imports verbatim and round-trips", () => {
    // Relative imports (`from .x import y`) used to be refused outright — they
    // front-ran every real file. Now the leading dots ride on the source
    // specifier so the import survives the parse and re-emits unchanged.
    const src = [
      "from .auth import HTTPBasicAuth",
      "from . import sessions",
      "from ..models import Response",
      "",
      "",
      "def f(n: int) -> None:",
      "    x = HTTPBasicAuth(n)",
      "    print(x)",
      "",
    ].join("\n");

    const sys = liftPython(src);
    expect(validateSystem(sys).ok).toBe(true);
    expect(sys.imports?.map((i) => ({ source: i.source, bindings: i.bindings }))).toEqual([
      { source: ".auth", bindings: [{ kind: "named", imported: "HTTPBasicAuth", local: "HTTPBasicAuth" }] },
      { source: ".", bindings: [{ kind: "named", imported: "sessions", local: "sessions" }] },
      { source: "..models", bindings: [{ kind: "named", imported: "Response", local: "Response" }] },
    ]);

    const codeA = transpile(sys, "python");
    expect(codeA).toContain("from .auth import HTTPBasicAuth");
    expect(codeA).toContain("from . import sessions");
    expect(codeA).toContain("from ..models import Response");
    const codeB = transpile(liftPython(codeA), "python");
    expect(codeB).toBe(codeA);
  });

  it("refuses a star import (binds names we cannot see)", () => {
    const src = "from os import *\n\n\ndef f() -> None:\n    pass\n";
    expect(() => liftPython(src)).toThrow();
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

describe.skipIf(!hasPython())("lift: Python docstrings (capture + round-trip)", () => {
  it("captures a function docstring as the module's doc and round-trips", () => {
    // Before docstrings were captured, the leading string statement was an
    // `unsupported stmt` — it blocked nearly every real function. Now it round-trips.
    const src = [
      "def greet(name: str) -> None:",
      '    """Print a greeting."""',
      "    print(name)",
      "",
    ].join("\n");
    const sys = liftPython(src);
    expect(validateSystem(sys).ok).toBe(true);
    expect(sys.modules["greet"]!.doc).toBe("Print a greeting.");
    const codeA = transpile(sys, "python");
    expect(codeA).toContain('"""Print a greeting."""');
    const codeB = transpile(liftPython(codeA), "python");
    expect(codeB).toBe(codeA);
  });

  it("captures class + method docstrings and round-trips", () => {
    const src = [
      "class Widget:",
      '    """A widget."""',
      "",
      "    def render(self) -> None:",
      '        """Draw it."""',
      "        print(1)",
      "",
    ].join("\n");
    const sys = liftPython(src);
    expect(validateSystem(sys).ok).toBe(true);
    expect(sys.modules["Widget"]!.doc).toBe("A widget.");
    expect(sys.modules["Widget.render"]!.doc).toBe("Draw it.");
    const codeA = transpile(sys, "python");
    const codeB = transpile(liftPython(codeA), "python");
    expect(codeB).toBe(codeA);
  });

  it("tolerates a docstring-only body (no `pass` filler needed) and round-trips", () => {
    const src = 'def stub() -> None:\n    """Not implemented yet."""\n';
    const sys = liftPython(src);
    expect(validateSystem(sys).ok).toBe(true);
    const codeA = transpile(sys, "python");
    expect(codeA).toContain('"""Not implemented yet."""');
    expect(codeA).not.toContain("pass"); // the docstring IS the body
    expect(transpile(liftPython(codeA), "python")).toBe(codeA);
  });

  it("round-trips a multi-line docstring (escaped to a reparse-stable literal)", () => {
    const src = [
      "def f(x: int) -> None:",
      '    """First line.',
      "",
      "    More detail.",
      '    """',
      "    print(x)",
      "",
    ].join("\n");
    const sys = liftPython(src);
    expect(validateSystem(sys).ok).toBe(true);
    expect(sys.modules["f"]!.doc).toContain("First line.");
    expect(transpile(liftPython(transpile(sys, "python")), "python")).toBe(transpile(sys, "python"));
  });

  it("cross-compiles a Python docstring to a TS JSDoc block", () => {
    const sys = liftPython('def greet(name: str) -> None:\n    """Hello."""\n    print(name)\n');
    const ts = transpile(sys, "ts");
    expect(ts).toContain("/**");
    expect(ts).toContain("* Hello.");
  });
});

describe("lift: TS JSDoc (capture + round-trip)", () => {
  it("captures a JSDoc block as the module's doc and round-trips", () => {
    const src = [
      "/**",
      " * Print a greeting.",
      " */",
      "export function greet(name: string): void {",
      "  console.log(name);",
      "}",
      "",
    ].join("\n");
    const sys = liftTypeScript(src);
    expect(validateSystem(sys).ok).toBe(true);
    expect(sys.modules["greet"]!.doc).toBe("Print a greeting.");
    const codeA = transpile(sys, "ts");
    expect(codeA).toContain(" * Print a greeting.");
    const codeB = transpile(liftTypeScript(codeA), "ts");
    expect(codeB).toBe(codeA);
  });

  it("round-trips a class + method JSDoc", () => {
    const src = [
      "/**",
      " * A widget.",
      " */",
      "export class Widget {",
      "  /**",
      "   * Draw it.",
      "   */",
      "  render(): void {",
      "    console.log(1);",
      "  }",
      "}",
      "",
    ].join("\n");
    const sys = liftTypeScript(src);
    expect(validateSystem(sys).ok).toBe(true);
    expect(sys.modules["Widget"]!.doc).toBe("A widget.");
    expect(sys.modules["Widget.render"]!.doc).toBe("Draw it.");
    const codeA = transpile(sys, "ts");
    const codeB = transpile(liftTypeScript(codeA), "ts");
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
      // for-of over a collection → a `foreach` node; the element binds out as `item`.
      name: "for-of → foreach node",
      src: "export function printAll(items: number[]): void {\n  for (const item of items) {\n    console.log(item);\n  }\n}\n",
      expectA: "for (const item of items) {",
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
    {
      // Re-raising the caught binding → a terminal `rethrow` node; the value is
      // passed on UNWRAPPED (`throw e`, not `throw new Error(e)`).
      name: "rethrow (throw e) → rethrow node",
      src: "export function risky(n: number): void {\n  try {\n    console.log(n);\n  } catch (e) {\n    throw e;\n  }\n}\n",
      expectA: "    throw e;",
    },
    {
      // A typed/custom error → a `throw` node carrying `errorType`; the constructor
      // name survives the round-trip instead of collapsing to the catch-all `Error`.
      name: "typed throw (throw new TypeError) → throw node with errorType",
      src: 'export function risky(n: number): void {\n  if ((n < 0)) {\n    throw new TypeError("negative");\n  }\n  console.log(n);\n}\n',
      expectA: 'throw new TypeError("negative");',
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

describe.skipIf(!hasPython())("lift: Python for-each (collection loop)", () => {
  const SRC = "def print_all(items: list) -> None:\n    for item in items:\n        print(item)\n";

  it("lifts a non-range for-in → foreach node and round-trips (Python)", () => {
    const sys = liftPython(SRC);
    expect(validateSystem(sys).ok).toBe(true);
    const codeA = transpile(sys, "python");
    expect(codeA).toContain("for item in items:");
    const codeB = transpile(liftPython(codeA), "python");
    expect(codeB).toBe(codeA);
    // The same IR cross-compiles to a TS for-of.
    expect(transpile(sys, "ts")).toContain("for (const item of items) {");
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

describe.skipIf(!hasPython())("lift: Python re-raise (rethrow)", () => {
  const SRC = "def risky(n: int) -> None:\n    try:\n        print(n)\n    except Exception as e:\n        raise e\n";

  it("lifts `raise e` → rethrow node and round-trips (Python)", () => {
    const sys = liftPython(SRC);
    expect(validateSystem(sys).ok).toBe(true);
    const codeA = transpile(sys, "python");
    expect(codeA).toContain("raise e");
    expect(codeA).not.toContain("raise Exception(e)"); // re-raised UNWRAPPED
    const codeB = transpile(liftPython(codeA), "python");
    expect(codeB).toBe(codeA);
    // The same IR cross-compiles to a TS rethrow.
    expect(transpile(sys, "ts")).toContain("throw e;");
  });

  it("still refuses a bare `raise` (implicit current exception, no value to wire)", () => {
    const src = "def risky(n: int) -> None:\n    try:\n        print(n)\n    except Exception:\n        raise\n";
    expect(() => liftPython(src)).toThrow();
  });
});

describe.skipIf(!hasPython())("lift: Python typed raise (throw with errorType)", () => {
  const SRC = "def risky(n: int) -> None:\n    if n < 0:\n        raise TypeError(\"negative\")\n    print(n)\n";

  it("lifts `raise TypeError(...)` → throw node with errorType and round-trips (Python)", () => {
    const sys = liftPython(SRC);
    expect(validateSystem(sys).ok).toBe(true);
    const codeA = transpile(sys, "python");
    expect(codeA).toContain('raise TypeError("negative")');
    expect(codeA).not.toContain("raise Exception"); // the type is preserved, not flattened
    const codeB = transpile(liftPython(codeA), "python");
    expect(codeB).toBe(codeA);
    // The same IR cross-compiles to a TS typed throw.
    expect(transpile(sys, "ts")).toContain('throw new TypeError("negative");');
  });
});

describe.skipIf(!hasPython())("lift: provenance links nodes back to source spans (Python)", () => {
  const SRC = [
    "def validate(qty: int) -> None:",
    "    if qty < 0:",
    '        raise ValueError("negative quantity")',
    "    print(qty)",
    "",
  ].join("\n");

  /** Resolve a single-line span to the source text it covers — the visual↔code glue. */
  function sliceOf(src: string, sp: { start: { line: number; col: number }; end: { line: number; col: number } }): string {
    const lines = src.split("\n");
    if (sp.start.line === sp.end.line) return lines[sp.start.line - 1]!.slice(sp.start.col, sp.end.col);
    return lines[sp.start.line - 1]!.slice(sp.start.col);
  }

  it("stamps each control/effect node with the span it was lifted from", () => {
    const sys = liftPython(SRC);
    expect(validateSystem(sys).ok).toBe(true);

    const mod = sys.modules["validate"]!;
    // The module itself carries provenance back to its `def`.
    expect(mod.prov?.start.line).toBe(1);

    const byKind = (k: string) => mod.interior.nodes.find((n) => n.kind === k)!;
    const branch = byKind("branch");
    const thr = byKind("throw");
    const effect = byKind("effect");

    // Every lifted node has provenance, and it resolves to the right source.
    expect(branch.prov && sliceOf(SRC, branch.prov)).toBe("if qty < 0:");
    expect(thr.prov && sliceOf(SRC, thr.prov)).toBe('raise ValueError("negative quantity")');
    expect(effect.prov && sliceOf(SRC, effect.prov)).toBe("print(qty)");
  });
});

/**
 * Behavioral round-trip: code → lift → transpile must preserve *meaning*, not
 * just structure. We run the hand-written original and the round-tripped output
 * against the same driver and compare stdout. The original's own runtime output
 * is the oracle — no hardcoded expectation — so this is immune to the benign
 * differences (formatting, identifier casing, ternary/return-select desugaring)
 * that would defeat a text comparison, while still catching real lift loss
 * (a dropped statement or altered control flow changes observable behavior).
 *
 * The sources are deliberately non-canonical (no doubled parens, names the
 * transpiler never chose) — code the transpiler never produced.
 */
describe("lift: behavioral round-trip preserves observable behavior (TS)", () => {
  const dir = mkdtempSync(join(tmpdir(), "kontur-rt-"));
  const tsx = fileURLToPath(new URL("../../node_modules/.bin/tsx", import.meta.url));

  /** Write `src` + `driver` to a file, execute, return trimmed stdout. */
  function runTS(src: string, driver: string, tag: string): string {
    const file = join(dir, `${tag}.ts`);
    writeFileSync(file, `${src}\n${driver}\n`);
    return execFileSync(tsx, [file], { encoding: "utf8" }).trim();
  }

  const cases: { name: string; src: string; driver: string }[] = [
    {
      name: "for-loop with effect",
      src: "export function countup(limit: number): void {\n  for (let i = 1; i <= limit; i++) {\n    console.log(i);\n  }\n}\n",
      driver: "countup(3);",
    },
    {
      name: "loop + branch with effect arms (fizzbuzz-shaped)",
      src: "export function parity(limit: number): void {\n  for (let i = 1; i <= limit; i++) {\n    if (i % 2 === 0) {\n      console.log(\"even\");\n    } else {\n      console.log(\"odd\");\n    }\n  }\n}\n",
      driver: "parity(4);",
    },
    {
      name: "for-of + a ternary-returning helper",
      src: "export function sign(x: number): string {\n  return x < 0 ? \"neg\" : \"pos\";\n}\nexport function signs(items: number[]): void {\n  for (const item of items) {\n    console.log(sign(item));\n  }\n}\n",
      driver: "signs([3, -1, 0]);",
    },
    {
      name: "both-arm returns → select",
      src: "export function classify(x: number): string {\n  if (x < 0) {\n    return \"neg\";\n  } else {\n    return \"pos\";\n  }\n}\n",
      driver: 'console.log(classify(-5));\nconsole.log(classify(2));',
    },
  ];

  for (const { name, src, driver } of cases) {
    it(`${name}: round-tripped code behaves identically to the original`, () => {
      const sys = liftTypeScript(src);
      expect(validateSystem(sys).ok).toBe(true);
      const roundTripped = transpile(sys, "ts");
      const tag = name.replace(/\W+/g, "-");
      const expected = runTS(src, driver, `${tag}-orig`);
      const actual = runTS(roundTripped, driver, `${tag}-rt`);
      expect(actual).toBe(expected);
    });
  }
});

describe("lift: rejects out-of-scope code (fails loudly, never lies)", () => {
  it("refuses a loop accumulator (carried IN) instead of flattening it to one iteration", () => {
    // Regression: `total = total + i` reads `total` from the prior iteration. The
    // single-assignment dataflow IR has no feedback edge, so lifting once used to
    // silently collapse this to `0 + i`. It must be refused, not lifted to a lie.
    const src = [
      "export function sum(n: number): number {",
      "  let total = 0;",
      "  for (let i = 1; i <= n; i++) {",
      "    total = total + i;",
      "  }",
      "  return total;",
      "}",
    ].join("\n");
    expect(() => liftTypeScript(src)).toThrow(/carries variable "total" across loop/);
  });

  it("refuses a value carried OUT of a loop (read after the loop)", () => {
    const src = [
      "export function lastDouble(n: number): number {",
      "  let last = 0;",
      "  for (let i = 1; i <= n; i++) {",
      "    last = i * 2;",
      "  }",
      "  return last;",
      "}",
    ].join("\n");
    expect(() => liftTypeScript(src)).toThrow(/carries variable "last" across loop/);
  });

  it("still lifts a loop-LOCAL temporary (assigned and read within one iteration)", () => {
    const src = [
      "export function doubles(n: number): void {",
      "  for (let i = 1; i <= n; i++) {",
      "    const d = i * 2;",
      "    console.log(d);",
      "  }",
      "}",
    ].join("\n");
    const lifted = liftTypeScript(src);
    expect(validateSystem(lifted).ok).toBe(true);
    // The temporary inlines on the way back out — behavior preserved, no carry.
    expect(transpile(lifted, "ts")).toContain("console.log((i * 2))");
  });

  it("refuses a thrown bare literal (throw \"x\") — not an error construction nor a named value", () => {
    const src = [
      "export function risky(n: number): void {",
      "  if ((n < 0)) {",
      '    throw "negative";',
      "  }",
      "  console.log(n);",
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

  it("refuses a for-of with a destructuring binding (foreach binds a single name)", () => {
    const src = [
      "export function f(pairs: number[][]): void {",
      "  for (const [a, b] of pairs) {",
      "    console.log(a);",
      "  }",
      "}",
    ].join("\n");
    expect(() => liftTypeScript(src)).toThrow(/for-of binding/);
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
