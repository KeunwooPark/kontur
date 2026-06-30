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

// Roadmap item 3: these constructs used to be silently dropped (extract_ast.py
// never read decorator_list / bases / vararg / kwarg / defaults), so a file
// lifted "successfully" but lost real structure. They now refuse loudly until
// items 4-6 give them a faithful IR home.
describe.skipIf(!hasPython())("lift: refuse silently-dropped constructs (Python)", () => {
  // Item 6 turned plain decorators into real captured IR (see "lift: decorators"
  // below). @staticmethod / @classmethod stay refused — they drop/rename the
  // implicit receiver, a parameter-contract change beyond metadata capture.
  it("refuses @staticmethod (alters the implicit receiver)", () => {
    const src = "class C:\n    @staticmethod\n    def f(x: int) -> int:\n        return x\n";
    expect(() => liftPython(src)).toThrow(/staticmethod/);
  });

  it("refuses @classmethod (alters the implicit receiver)", () => {
    const src = "class C:\n    @classmethod\n    def f(cls, x: int) -> int:\n        return x\n";
    expect(() => liftPython(src)).toThrow(/classmethod/);
  });

  // Item 4 turned defaults, *args/**kwargs, and keyword-only params into real
  // captured IR (see "lift: full signatures" below). Positional-only stays
  // refused — rarer, and still without an IR home.
  it("refuses a positional-only parameter", () => {
    const src = "def f(n: int, /) -> None:\n    print(n)\n";
    expect(() => liftPython(src)).toThrow(/positional-only/);
  });

  it("refuses a non-literal default value (only a literal or name is modelled)", () => {
    const src = "def f(n: int = 1 + 1) -> None:\n    print(n)\n";
    expect(() => liftPython(src)).toThrow(/default value/);
  });

  // Item 5 turned positional base classes into real captured IR (see "lift: class
  // inheritance" below). Keyword bases (metaclass=) and non-name base expressions
  // (Generic[T]) stay refused — still without an IR home.
  it("refuses a keyword base (metaclass=)", () => {
    const src = "class C(metaclass=Meta):\n    pass\n";
    expect(() => liftPython(src)).toThrow(/keyword base|metaclass/);
  });

  it("refuses a non-name base expression (Generic[T])", () => {
    const src = "class C(Generic[T]):\n    pass\n";
    expect(() => liftPython(src)).toThrow(/base class expression/);
  });
});

// Roadmap item 4: full signatures. Default values, *args/**kwargs, and
// keyword-only params are captured on the in-data ports (not lowered into the
// interior — they are contract shape) and re-emitted, so a real signature
// round-trips. An unused param (a forwarded **kwargs, a param no branch reads)
// is faithful, so the port-boundary invariant tolerates an unconnected in-port.
describe.skipIf(!hasPython())("lift: full signatures (Python)", () => {
  const roundtrips = (src: string) => {
    const sys = liftPython(src);
    expect(validateSystem(sys).ok).toBe(true);
    const codeA = transpile(sys, "python");
    expect(codeA).toContain(src.trimEnd());
    expect(transpile(liftPython(codeA), "python")).toBe(codeA); // fixed point
    return sys;
  };

  it("captures a literal default and round-trips it", () => {
    const sys = roundtrips("def greet(name: str, count: int = 1) -> None:\n    print(name)\n");
    const port = sys.modules["greet"]!.ports.find((p) => p.name === "count");
    expect(port?.default).toEqual({ t: "lit", value: 1 });
  });

  it("captures a None / bool / str default and round-trips it", () => {
    roundtrips("def opts(a: str = \"x\", b: bool = False, c: int = None) -> None:\n    print(a)\n");
  });

  it("captures a bare-name default and round-trips it", () => {
    const sys = roundtrips("def connect(timeout: int = default_timeout) -> None:\n    print(timeout)\n");
    const port = sys.modules["connect"]!.ports.find((p) => p.name === "timeout");
    expect(port?.default).toEqual({ t: "var", name: "default_timeout" });
  });

  it("captures *args (variadic, unused) and round-trips it", () => {
    const sys = roundtrips("def collect(first: int, *rest) -> None:\n    print(first)\n");
    expect(sys.modules["collect"]!.ports.find((p) => p.name === "rest")?.variadic).toBe("args");
  });

  it("captures **kwargs (variadic, unused) and round-trips it", () => {
    const sys = roundtrips("def call(url: str, **kwargs) -> None:\n    print(url)\n");
    expect(sys.modules["call"]!.ports.find((p) => p.name === "kwargs")?.variadic).toBe("kwargs");
  });

  it("captures a keyword-only param (bare * separator) and round-trips it", () => {
    const sys = roundtrips("def fetch(a: int, *, verbose: bool = False) -> None:\n    print(a)\n");
    expect(sys.modules["fetch"]!.ports.find((p) => p.name === "verbose")?.keywordOnly).toBe(true);
  });

  it("round-trips a full signature (positional, *args, kw-only default, **kwargs)", () => {
    roundtrips("def request(method: str, url: str, *args, timeout: int = 30, **kwargs) -> None:\n    print(method)\n");
  });
});

describe("lift: full signatures (TS)", () => {
  it("captures a default and a rest param and round-trips them", () => {
    const src = [
      "export function collect(first: number, count: number = 1, ...rest: number[]): void {",
      "  console.log(first);",
      "}",
      "",
    ].join("\n");
    const sys = liftTypeScript(src);
    expect(validateSystem(sys).ok).toBe(true);
    const ports = sys.modules["collect"]!.ports;
    expect(ports.find((p) => p.name === "count")?.default).toEqual({ t: "lit", value: 1 });
    expect(ports.find((p) => p.name === "rest")?.variadic).toBe("args");
    const codeA = transpile(sys, "ts");
    expect(codeA).toContain("count: number = 1, ...rest: number[]");
    expect(transpile(liftTypeScript(codeA), "ts")).toBe(codeA); // fixed point
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

describe.skipIf(!hasPython())("lift: class inheritance (Python)", () => {
  it("captures a single base class onto the class module and round-trips", () => {
    const src = [
      "class HttpError(RequestException):",
      "    code: int",
      "",
      "    def status(self) -> int:",
      "        return self.code",
      "",
    ].join("\n");
    const sys = liftPython(src);
    expect(validateSystem(sys).ok).toBe(true);
    expect(sys.modules["HttpError"]!.bases).toEqual(["RequestException"]);
    const codeA = transpile(sys, "python");
    expect(codeA).toContain("class HttpError(RequestException):");
    expect(transpile(liftPython(codeA), "python")).toBe(codeA); // fixed point
  });

  it("captures multiple and dotted bases and round-trips them in order", () => {
    const src = [
      "class CaseInsensitiveDict(collections.abc.MutableMapping, Base):",
      "    pass",
      "",
    ].join("\n");
    const sys = liftPython(src);
    expect(sys.modules["CaseInsensitiveDict"]!.bases).toEqual([
      "collections.abc.MutableMapping",
      "Base",
    ]);
    const codeA = transpile(sys, "python");
    expect(codeA).toContain("class CaseInsensitiveDict(collections.abc.MutableMapping, Base):");
    expect(transpile(liftPython(codeA), "python")).toBe(codeA); // fixed point
  });
});

describe("lift: class inheritance (TS)", () => {
  it("captures an `extends` base and round-trips it", () => {
    const src = [
      "export class HttpError extends RequestException {",
      "  code: number;",
      "",
      "  status(): number {",
      "    return this.code;",
      "  }",
      "}",
      "",
    ].join("\n");
    const sys = liftTypeScript(src);
    expect(validateSystem(sys).ok).toBe(true);
    expect(sys.modules["HttpError"]!.bases).toEqual(["RequestException"]);
    const codeA = transpile(sys, "ts");
    expect(codeA).toContain("export class HttpError extends RequestException {");
    expect(transpile(liftTypeScript(codeA), "ts")).toBe(codeA); // fixed point
  });

  it("refuses an `implements` clause (no IR home)", () => {
    const src = "export class C implements I {\n}\n";
    expect(() => liftTypeScript(src)).toThrow(/implements/);
  });
});

// Roadmap item 6: decorators. Captured VERBATIM (sans `@`) as opaque metadata on
// the function/method/class module — like base classes — and re-emitted as
// `@<text>` lines, so a decorated definition round-trips. @staticmethod /
// @classmethod stay refused (they alter the implicit receiver, see above).
describe.skipIf(!hasPython())("lift: decorators (Python)", () => {
  const roundtrips = (src: string) => {
    const sys = liftPython(src);
    expect(validateSystem(sys).ok).toBe(true);
    const codeA = transpile(sys, "python");
    expect(codeA).toContain(src.trimEnd());
    expect(transpile(liftPython(codeA), "python")).toBe(codeA); // fixed point
    return sys;
  };

  it("captures a bare-name function decorator and round-trips it", () => {
    const sys = roundtrips("@overload\ndef f(x: int) -> int:\n    return x\n");
    expect(sys.modules["f"]!.decorators).toEqual(["overload"]);
  });

  it("captures a dotted-name function decorator and round-trips it", () => {
    const sys = roundtrips("@contextlib.contextmanager\ndef f(x: int) -> int:\n    return x\n");
    expect(sys.modules["f"]!.decorators).toEqual(["contextlib.contextmanager"]);
  });

  it("captures a call decorator (with args) and round-trips it", () => {
    const sys = roundtrips("@app.route('/x', methods=['GET'])\ndef f(x: int) -> int:\n    return x\n");
    expect(sys.modules["f"]!.decorators).toEqual(["app.route('/x', methods=['GET'])"]);
  });

  it("captures stacked decorators outermost-first and round-trips them", () => {
    const sys = roundtrips("@a\n@b.c\ndef f(x: int) -> int:\n    return x\n");
    expect(sys.modules["f"]!.decorators).toEqual(["a", "b.c"]);
  });

  it("captures a @property method decorator and round-trips it", () => {
    const src = [
      "class Box:",
      "    value: int",
      "",
      "    @property",
      "    def size(self) -> int:",
      "        return self.value",
      "",
    ].join("\n");
    const sys = roundtrips(src);
    expect(sys.modules["Box.size"]!.decorators).toEqual(["property"]);
  });

  it("captures a class decorator and round-trips it", () => {
    const sys = roundtrips("@runtime_checkable\nclass C:\n    pass\n");
    expect(sys.modules["C"]!.decorators).toEqual(["runtime_checkable"]);
  });
});

describe("lift: decorators (TS)", () => {
  it("captures a class decorator and round-trips it", () => {
    const src = [
      "@sealed",
      "export class Box {",
      "  value: number;",
      "",
      "  size(): number {",
      "    return this.value;",
      "  }",
      "}",
      "",
    ].join("\n");
    const sys = liftTypeScript(src);
    expect(validateSystem(sys).ok).toBe(true);
    expect(sys.modules["Box"]!.decorators).toEqual(["sealed"]);
    const codeA = transpile(sys, "ts");
    expect(codeA).toContain("@sealed\nexport class Box {");
    expect(transpile(liftTypeScript(codeA), "ts")).toBe(codeA); // fixed point
  });

  it("captures a method decorator and round-trips it", () => {
    const src = [
      "export class Box {",
      "  value: number;",
      "",
      "  @enumerable(false)",
      "  size(): number {",
      "    return this.value;",
      "  }",
      "}",
      "",
    ].join("\n");
    const sys = liftTypeScript(src);
    expect(validateSystem(sys).ok).toBe(true);
    expect(sys.modules["Box.size"]!.decorators).toEqual(["enumerable(false)"]);
    const codeA = transpile(sys, "ts");
    expect(codeA).toContain("  @enumerable(false)\n  size(): number {");
    expect(transpile(liftTypeScript(codeA), "ts")).toBe(codeA); // fixed point
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

describe.skipIf(!hasPython())("lift: f-strings lower to the concat op (Python)", () => {
  const SRC = [
    "def label(x: int) -> str:",
    '    return f"value={x}"',
    "",
  ].join("\n");

  it("lifts an f-string to a `concat` function node", () => {
    const sys = liftPython(SRC);
    expect(validateSystem(sys).ok).toBe(true);
    const ops = sys.modules["label"]!.interior.nodes
      .filter((n) => n.kind === "function")
      .map((n) => (n as { op?: string }).op);
    expect(ops).toContain("concat");
  });

  it("Python round-trip (lift → transpile → lift → transpile) is a fixed point", () => {
    // Like the TS template literal, an f-string lowers to a `concat` chain that
    // each backend emits as `+`; re-lifting that `+` is a `concat`-free fixed point.
    const codeA = transpile(liftPython(SRC), "python");
    expect(codeA).toContain('return ("value=" + x)');
    const codeB = transpile(liftPython(codeA), "python");
    expect(codeB).toBe(codeA);
  });

  it("folds multiple interpolations and literal segments left-to-right", () => {
    const src = ['def g(a: int, b: int) -> str:', '    return f"{a}-{b}!"', ""].join("\n");
    expect(transpile(liftPython(src), "python")).toContain('return (((a + "-") + b) + "!")');
  });

  it("cross-compiles the same IR to a TS template-equivalent `+` chain", () => {
    expect(transpile(liftPython(SRC), "ts")).toContain('return ("value=" + x);');
  });

  it("refuses an f-string conversion / format spec (not representable as concat)", () => {
    expect(() => liftPython(['def g(x: int) -> str:', '    return f"{x:.2f}"', ""].join("\n"))).toThrow(
      /format spec|conversion/,
    );
    expect(() => liftPython(['def g(x: int) -> str:', '    return f"{x!r}"', ""].join("\n"))).toThrow(
      /format spec|conversion/,
    );
  });
});

describe.skipIf(!hasPython())("lift: augmented assignment desugars to assign(bin) (Python)", () => {
  it("lowers `n += 1` to a bin-op reassignment that SSA-inlines into its use", () => {
    // Like the TS lifter, `+=` is a pure rebind: `n += 1; print(n)` collapses to
    // `print((n + 1))`, and re-lifting that is a fixed point (the `+=` sugar is gone).
    const src = ["def tick(n: int) -> None:", "    n += 1", "    print(n)", ""].join("\n");
    const sys = liftPython(src);
    expect(validateSystem(sys).ok).toBe(true);
    const codeA = transpile(sys, "python");
    expect(codeA).toContain("print((n + 1))");
    const codeB = transpile(liftPython(codeA), "python");
    expect(codeB).toBe(codeA);
  });

  it("cross-compiles `n += 1` to the same `+` chain in TS", () => {
    const src = ["def tick(n: int) -> None:", "    n += 1", "    print(n)", ""].join("\n");
    expect(transpile(liftPython(src), "ts")).toContain("console.log((n + 1));");
  });

  it("desugars every modelled augmented operator (-= *= /= %=)", () => {
    for (const [aug, want] of [["-=", "-"], ["*=", "*"], ["/=", "/"], ["%=", "%"]] as const) {
      const src = ["def f(n: int) -> None:", `    n ${aug} 2`, "    print(n)", ""].join("\n");
      expect(transpile(liftPython(src), "python")).toContain(`print((n ${want} 2))`);
    }
  });

  it("desugars `self.attr += y` to a stateSet over the current state", () => {
    const src = [
      "class Counter:",
      "    total: int",
      "    def bump(self, by: int) -> None:",
      "        self.total += by",
      "",
    ].join("\n");
    const sys = liftPython(src);
    expect(validateSystem(sys).ok).toBe(true);
    const codeA = transpile(sys, "python");
    expect(codeA).toContain("self.total = (self.total + by)");
    expect(transpile(liftPython(codeA), "python")).toBe(codeA);
  });

  it("refuses an unmodelled augmented operator (`**=`)", () => {
    const src = ["def f(n: int) -> None:", "    n **= 2", "    print(n)", ""].join("\n");
    expect(() => liftPython(src)).toThrow(/augmented-assignment operator/);
  });

  it("now lifts a subscript lvalue target (`d[k] += v` — item 13 added the lvalue model)", () => {
    const src = ["def f(d: dict, k: int) -> None:", "    d[k] += 1", "    print(d)", ""].join("\n");
    const sys = liftPython(src);
    expect(validateSystem(sys).ok).toBe(true);
    const codeA = transpile(sys, "python");
    expect(codeA).toContain("d[k] = (d[k] + 1)");
    expect(transpile(liftPython(codeA), "python")).toBe(codeA);
  });
});

describe.skipIf(!hasPython())("lift: prefix unary operators (-x, +x, ~x) (Python)", () => {
  it("lifts each arithmetic/bitwise prefix op and is a round-trip fixed point", () => {
    // Each shares the `un` node alongside logical `not`; `-x`/`+x`/`~x` re-emit
    // with their own glyph and re-lifting is a fixed point.
    for (const sym of ["-", "+", "~"] as const) {
      const src = ["def f(x: int) -> int:", `    return ${sym}x`, ""].join("\n");
      const sys = liftPython(src);
      expect(validateSystem(sys).ok).toBe(true);
      const codeA = transpile(sys, "python");
      expect(codeA).toContain(`return (${sym}x)`);
      expect(transpile(liftPython(codeA), "python")).toBe(codeA);
    }
  });

  it("cross-compiles `-x` to the same prefix form in TS", () => {
    const src = ["def f(x: int) -> int:", "    return -x", ""].join("\n");
    expect(transpile(liftPython(src), "ts")).toContain("return (-x);");
  });

  it("refuses an unmodelled prefix op (`++x`)", () => {
    // Increment/decrement are not modelled; the Python source equivalent has no
    // such form, so this is the TS-side guard exercised via a TS source.
    const src = "export function f(x: number): number {\n  return ++x;\n}\n";
    expect(() => liftTypeScript(src)).toThrow(/prefix operator/);
  });
});

describe.skipIf(!hasPython())("lift: identity & membership comparisons (is / is not / in / not in) (Python)", () => {
  it("lifts each comparison and is a round-trip fixed point", () => {
    // Four comparison ops join eq/ne/lt/…; each rides the `bin` node on pins
    // "a","b" and re-emits with its Python spelling, so re-lifting is a fixed point.
    for (const frag of ["x is None", "x is not None", "x in items", "x not in items"]) {
      const src = ["def f(x: int, items: int) -> bool:", `    return ${frag}`, ""].join("\n");
      const sys = liftPython(src);
      expect(validateSystem(sys).ok).toBe(true);
      const codeA = transpile(sys, "python");
      expect(codeA).toContain(`return (${frag})`);
      expect(transpile(liftPython(codeA), "python")).toBe(codeA);
    }
  });

  it("cross-compiles identity to ===/!== and membership to .includes() in TS", () => {
    const mk = (frag: string) =>
      transpile(liftPython(["def f(x: int, items: int) -> bool:", `    return ${frag}`, ""].join("\n")), "ts");
    expect(mk("x is None")).toContain("return (x === null);");
    expect(mk("x is not None")).toContain("return (x !== null);");
    expect(mk("x in items")).toContain("return (items.includes(x));");
    expect(mk("x not in items")).toContain("return (!items.includes(x));");
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
      name: "prefix negate (-x) → un node",
      src: "export function neg(x: number): number {\n  return -x;\n}\n",
      expectA: "return (-x);",
    },
    {
      name: "bitwise not (~x) → un node",
      src: "export function bnot(x: number): number {\n  return ~x;\n}\n",
      expectA: "return (~x);",
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

describe.skipIf(!hasPython())("lift: Python iterable comprehensions (item 11)", () => {
  const rt = (src: string) => {
    const sys = liftPython(src);
    expect(validateSystem(sys).ok).toBe(true);
    const a = transpile(sys, "python");
    expect(transpile(liftPython(a), "python")).toBe(a); // Python fixed point
    return { sys, py: a };
  };

  it("lifts a list comprehension over an arbitrary iterable, with an if-filter", () => {
    const { py } = rt("def f(items: list) -> None:\n    print([(x * 2) for x in items if (x > 0)])\n");
    expect(py).toContain("[(x * 2) for x in items if (x > 0)]");
  });

  it("lifts a dict comprehension (the hooks.py shape) and round-trips", () => {
    const { sys, py } = rt("def default_hooks(hooks: list) -> None:\n    print({event: [] for event in hooks})\n");
    expect(py).toContain("{event: [] for event in hooks}");
    // Cross-compiles to a TS Object.fromEntries(map) — a one-way emit.
    expect(transpile(sys, "ts")).toContain("Object.fromEntries(hooks.map((event) => [event, []]))");
  });

  it("lifts a set comprehension and round-trips", () => {
    const { py } = rt("def f(items: list) -> None:\n    print({x for x in items})\n");
    expect(py).toContain("{x for x in items}");
  });

  it("lifts a generator expression and round-trips", () => {
    const { sys, py } = rt("def f(items: list, ok: bool) -> None:\n    print((x for x in items if ok))\n");
    expect(py).toContain("(x for x in items if ok)");
    expect(transpile(sys, "ts")).toContain("items.filter((x) => ok).map((x) => x)");
  });

  it("refuses a multi-generator comprehension (deferred)", () => {
    expect(() => liftPython("def f(a: list, b: list) -> None:\n    print([(x + y) for x in a for y in b])\n")).toThrow(
      /multi-generator comprehension/,
    );
  });

  it("lifts a dict comprehension with a tuple-unpack target (item 14B) and round-trips", () => {
    const src = "def f(d: dict) -> dict:\n    return {k: v for k, v in d}\n";
    const sys = liftPython(src);
    const node = sys.modules["f"]!.interior.nodes.find((n) => n.kind === "itercomp")!;
    expect((node as { names?: string[] }).names).toEqual(["k", "v"]);
    expect(transpile(sys, "python")).toContain("{k: v for k, v in d}");
    expect(transpile(sys, "ts")).toContain("Object.fromEntries(d.map(([k, v]) => [k, v]))");
  });
});

describe.skipIf(!hasPython())("lift: Python collection literals (item 12, slice B)", () => {
  const rt = (src: string) => {
    const sys = liftPython(src);
    expect(validateSystem(sys).ok).toBe(true);
    const a = transpile(sys, "python");
    expect(transpile(liftPython(a), "python")).toBe(a); // Python fixed point
    return { sys, py: a };
  };

  it("lifts a tuple literal and round-trips", () => {
    const { py } = rt("def f(a: int, b: int) -> None:\n    print((a, b))\n");
    expect(py).toContain("print((a, b))");
  });

  it("keeps a single-element tuple's trailing comma", () => {
    const { py } = rt("def f(a: int) -> None:\n    print((a,))\n");
    expect(py).toContain("print((a,))");
  });

  it("lifts a set literal and round-trips", () => {
    const { py } = rt("def f(a: int, b: int) -> None:\n    print({a, b})\n");
    expect(py).toContain("print({a, b})");
  });

  it("lifts a dict literal (the hooks.py shape) and round-trips", () => {
    const { sys, py } = rt('def f(a: int) -> None:\n    print({"x": a, "y": 1})\n');
    expect(py).toContain('print({"x": a, "y": 1})');
    // Cross-compiles to a TS Map — a one-way emit.
    expect(transpile(sys, "ts")).toContain('new Map([["x", a], ["y", 1]])');
  });

  it("lifts an empty dict literal (the hooks.py `{}`) and round-trips", () => {
    const { py } = rt("def f() -> None:\n    print({})\n");
    expect(py).toContain("print({})");
  });

  it("lifts a single-element set literal and round-trips", () => {
    const { py } = rt("def f(a: int) -> None:\n    print({a})\n");
    expect(py).toContain("print({a})");
  });

  it("cross-compiles tuple→array and set→new Set in TS", () => {
    const sys = liftPython("def f(a: int, b: int) -> None:\n    print((a, b))\n    print({a, b})\n");
    const ts = transpile(sys, "ts");
    expect(ts).toContain("console.log([a, b]);");
    expect(ts).toContain("console.log(new Set([a, b]));");
  });

  it("refuses a starred element in a tuple literal (deferred)", () => {
    expect(() => liftPython("def f(xs: list) -> None:\n    print((1, *xs))\n")).toThrow(/starred element/);
  });

  it("refuses a dict-unpacking entry (deferred)", () => {
    expect(() => liftPython("def f(d: dict) -> None:\n    print({**d, 'x': 1})\n")).toThrow(/dict-unpacking/);
  });
});

describe.skipIf(!hasPython())("lift: Python subscript & slice (item 12, slice C)", () => {
  const rt = (src: string) => {
    const sys = liftPython(src);
    expect(validateSystem(sys).ok).toBe(true);
    const a = transpile(sys, "python");
    expect(transpile(liftPython(a), "python")).toBe(a); // Python fixed point
    return { sys, py: a };
  };
  const nodeKinds = (sys: System, modId: string) =>
    sys.modules[modId]!.interior.nodes.map((n) => n.kind);

  it("lifts a variable subscript `a[i]` to an `index` node and round-trips", () => {
    const { sys, py } = rt("def f(a: list, i: int) -> int:\n    return a[i]\n");
    expect(py).toContain("return a[i]");
    expect(nodeKinds(sys, "f")).toContain("index");
  });

  it("lifts a constant-int subscript `a[0]` to `index` (not the string `member`)", () => {
    const { sys, py } = rt("def f(a: list) -> int:\n    return a[0]\n");
    expect(py).toContain("return a[0]"); // NOT a["0"]
    expect(nodeKinds(sys, "f")).toContain("index");
    expect(nodeKinds(sys, "f")).not.toContain("member");
  });

  it("still routes a constant-STRING subscript through `member` (no new `index` node)", () => {
    // A constant-string subscript on a bare name stays the `member` port accessor
    // — which resolves to a port-endpoint REF, not a node — so the interior gains
    // NO `index` node. Proof the string-key path is unchanged (cf. `a[0]` above,
    // which now does produce an `index`).
    const sys = liftPython('def f(r: dict) -> int:\n    return r["x"]\n');
    expect(nodeKinds(sys, "f")).not.toContain("index");
  });

  it("lifts a subscript on a call result and round-trips", () => {
    const { py } = rt('def f(s: str) -> str:\n    return s.split(".")[0]\n');
    expect(py).toContain('return s.split(".")[0]');
  });

  it("lifts an open-ended slice `a[:3]` (the requests __init__ shape) and round-trips", () => {
    const { sys, py } = rt('def f(s: str) -> list:\n    return s.split(".")[:3]\n');
    expect(py).toContain('return s.split(".")[:3]');
    expect(nodeKinds(sys, "f")).toContain("slice");
  });

  it("lifts each slice bound shape and round-trips", () => {
    expect(rt("def f(a: list) -> list:\n    return a[1:3]\n").py).toContain("return a[1:3]");
    expect(rt("def f(a: list) -> list:\n    return a[1:]\n").py).toContain("return a[1:]");
    expect(rt("def f(a: list) -> list:\n    return a[:]\n").py).toContain("return a[:]");
  });

  it("cross-compiles a subscript to `a[i]` and a slice to `.slice(...)` in TS", () => {
    const sys = liftPython("def f(a: list, i: int) -> list:\n    print(a[i])\n    return a[1:3]\n");
    const ts = transpile(sys, "ts");
    expect(ts).toContain("a[i]");
    expect(ts).toContain("a.slice(1, 3)");
  });

  it("refuses a step slice `a[::2]` (deferred)", () => {
    expect(() => liftPython("def f(a: list) -> list:\n    return a[::2]\n")).toThrow(/slice step/);
  });
});

describe("lift: subscript round-trips from TypeScript (item 12, slice C)", () => {
  it("lifts a TS subscript `a[i]` to an `index` node and is a fixed point", () => {
    const src = "export function f(a: number[], i: number): number {\n  return a[i];\n}\n";
    const sys = liftTypeScript(src);
    expect(validateSystem(sys).ok).toBe(true);
    const codeA = transpile(sys, "ts");
    expect(transpile(liftTypeScript(codeA), "ts")).toBe(codeA); // fixed point
    expect(codeA).toContain("return a[i];");
    expect(sys.modules["f"]!.interior.nodes.map((n) => n.kind)).toContain("index");
  });
});

describe.skipIf(!hasPython())("lift: subscript & attribute assignment targets (item 13, Python)", () => {
  const rt = (src: string) => {
    const sys = liftPython(src);
    expect(validateSystem(sys).ok).toBe(true);
    const a = transpile(sys, "python");
    expect(transpile(liftPython(a), "python")).toBe(a); // Python fixed point
    return { sys, py: a };
  };
  const nodeKinds = (sys: System, modId: string) =>
    sys.modules[modId]!.interior.nodes.map((n) => n.kind);

  it("lifts a member-assignment target `obj.attr = v` to an `attrSet` node and round-trips", () => {
    const { sys, py } = rt("def f(obj: object, v: int) -> None:\n    obj.attr = v\n");
    expect(py).toContain("obj.attr = v");
    expect(nodeKinds(sys, "f")).toContain("attrSet");
  });

  it("lifts a nested-receiver member assignment `obj.inner.attr = v` and round-trips", () => {
    const { py } = rt("def f(obj: object, v: int) -> None:\n    obj.inner.attr = v\n");
    expect(py).toContain("obj.inner.attr = v");
  });

  it("lifts a subscript-assignment target `d[k] = v` to an `indexSet` node and round-trips", () => {
    const { sys, py } = rt("def f(d: dict, k: str, v: int) -> None:\n    d[k] = v\n");
    expect(py).toContain("d[k] = v");
    expect(nodeKinds(sys, "f")).toContain("indexSet");
  });

  it("lifts a constant-string subscript write `d[\"x\"] = v` to `indexSet` (not a member)", () => {
    const { sys, py } = rt('def f(d: dict, v: int) -> None:\n    d["x"] = v\n');
    expect(py).toContain('d["x"] = v');
    expect(nodeKinds(sys, "f")).toContain("indexSet");
  });

  it("lifts an augmented subscript target `d[k] += v` (desugars, source fixed point)", () => {
    const { sys, py } = rt("def f(d: dict, k: str, v: int) -> None:\n    d[k] += v\n");
    expect(py).toContain("d[k] = (d[k] + v)");
    expect(nodeKinds(sys, "f")).toContain("indexSet");
  });

  it("lifts an augmented member target `obj.attr += v` (desugars, source fixed point)", () => {
    const { sys, py } = rt("def f(obj: object, v: int) -> None:\n    obj.attr += v\n");
    expect(py).toContain("obj.attr = (obj.attr + v)");
    expect(nodeKinds(sys, "f")).toContain("attrSet");
  });

  it("cross-compiles a member/subscript assignment to TS", () => {
    const sys = liftPython("def f(obj: object, d: dict, k: str, v: int) -> None:\n    obj.attr = v\n    d[k] = v\n");
    const ts = transpile(sys, "ts");
    expect(ts).toContain("obj.attr = v;");
    expect(ts).toContain("d[k] = v;");
  });

  it("refuses a slice-assignment target `d[1:3] = v` (deferred)", () => {
    expect(() => liftPython("def f(d: list, v: list) -> None:\n    d[1:3] = v\n")).toThrow(/slice-assignment/);
  });
});

describe("lift: subscript & attribute assignment round-trip from TypeScript (item 13)", () => {
  const rt = (src: string) => {
    const sys = liftTypeScript(src);
    expect(validateSystem(sys).ok).toBe(true);
    const codeA = transpile(sys, "ts");
    expect(transpile(liftTypeScript(codeA), "ts")).toBe(codeA); // fixed point
    return { sys, ts: codeA };
  };

  it("lifts a TS member assignment `obj.attr = v;` to `attrSet` and is a fixed point", () => {
    const { sys, ts } = rt("export function f(obj: Box, v: number): void {\n  obj.attr = v;\n}\n");
    expect(ts).toContain("obj.attr = v;");
    expect(sys.modules["f"]!.interior.nodes.map((n) => n.kind)).toContain("attrSet");
  });

  it("lifts a TS subscript assignment `d[k] = v;` to `indexSet` and is a fixed point", () => {
    const { sys, ts } = rt("export function f(d: Bag, k: string, v: number): void {\n  d[k] = v;\n}\n");
    expect(ts).toContain("d[k] = v;");
    expect(sys.modules["f"]!.interior.nodes.map((n) => n.kind)).toContain("indexSet");
  });

  it("lifts an augmented TS subscript `d[k] += v;` (desugars, fixed point)", () => {
    const { ts } = rt("export function f(d: Bag, k: string, v: number): void {\n  d[k] += v;\n}\n");
    expect(ts).toContain("d[k] = (d[k] + v);");
  });
});

describe.skipIf(!hasPython())("lift: tuple unpacking assignment (item 14, Python)", () => {
  const rt = (src: string) => {
    const sys = liftPython(src);
    expect(validateSystem(sys).ok).toBe(true);
    const a = transpile(sys, "python");
    expect(transpile(liftPython(a), "python")).toBe(a); // Python fixed point
    return { sys, py: a };
  };
  const nodeKinds = (sys: System, modId: string) =>
    sys.modules[modId]!.interior.nodes.map((n) => n.kind);

  it("unpacks a call result `a, b = f(x)` into an `unpack` node and round-trips", () => {
    // The requests `username, password = get_auth_from_url(url)` shape.
    const { sys, py } = rt(
      "def g(url: str) -> str:\n    a, b = get_auth_from_url(url)\n    return a\n",
    );
    expect(py).toContain("a, b = get_auth_from_url(url)");
    expect(py).toContain("return a");
    expect(nodeKinds(sys, "g")).toContain("unpack");
  });

  it("evaluates the unpacked value exactly ONCE (the call is not duplicated)", () => {
    // Both names read through the single `unpack` node, so the call appears once —
    // the whole reason unpack is a node, not N separate `value[i]` binds.
    const { py } = rt(
      "def g(url: str) -> str:\n    a, b = parse(url)\n    print(a)\n    print(b)\n    return a\n",
    );
    expect(py.match(/parse\(url\)/g)).toHaveLength(1);
  });

  it("unpacks a 7-name call result and round-trips (the requests parse_url shape)", () => {
    const { py } = rt(
      "def g(url: str) -> str:\n    scheme, auth, host, port, path, query, fragment = parse_url(url)\n    return host\n",
    );
    expect(py).toContain("scheme, auth, host, port, path, query, fragment = parse_url(url)");
  });

  it("unpacks a tuple literal `a, b = x, y` (the requests `None, None` shape)", () => {
    // A literal RHS rides a `collection` tuple node; it re-emits parenthesised but
    // is a fixed point thereafter.
    const { sys, py } = rt(
      "def g(x: int, y: int) -> int:\n    a, b = x, y\n    return a\n",
    );
    expect(py).toContain("a, b = (x, y)");
    expect(nodeKinds(sys, "g")).toContain("unpack");
    expect(nodeKinds(sys, "g")).toContain("collection");
  });

  it("unpacks a slice-of-call value and round-trips (the requests version-split shape)", () => {
    const { py } = rt(
      'def g(v: str) -> str:\n    major, minor, patch = v.split(".")[:3]\n    return major\n',
    );
    expect(py).toContain('major, minor, patch = v.split(".")[:3]');
  });

  it("cross-compiles tuple unpacking to a TS array destructuring", () => {
    const sys = liftPython("def g(url: str) -> str:\n    a, b = parse(url)\n    return a\n");
    const ts = transpile(sys, "ts");
    expect(ts).toContain("const [a, b] = parse(url);");
  });

  it("lifts chained assignment `x = y = z` (item 14C) — value evaluated once, round-trips", () => {
    const { sys, py } = rt("def g(z: int) -> int:\n    x = y = compute(z)\n    return x + y\n");
    expect(py).toContain("x = y = compute(z)");
    expect((py.match(/compute/g) ?? []).length).toBe(1); // evaluated once
    expect(nodeKinds(sys, "g")).toContain("broadcast");
    expect(transpile(sys, "ts")).toContain("let y = x;");
  });

  it("refuses a starred unpack target `a, *rest = xs` (deferred)", () => {
    expect(() => liftPython("def g(xs: list) -> int:\n    a, *rest = xs\n    return a\n")).toThrow(/starred unpack/);
  });

  it("refuses a nested unpack target `(a, b), c = xs` (deferred)", () => {
    expect(() => liftPython("def g(xs: list) -> int:\n    (a, b), c = xs\n    return c\n")).toThrow(/nested unpack/);
  });
});

describe.skipIf(!hasPython())("lift: for-target tuple unpacking (item 14B, Python)", () => {
  const rt = (src: string) => {
    const sys = liftPython(src);
    expect(validateSystem(sys).ok).toBe(true);
    const a = transpile(sys, "python");
    expect(transpile(liftPython(a), "python")).toBe(a); // Python fixed point
    return { sys, py: a };
  };
  const nodeKinds = (sys: System, modId: string) =>
    sys.modules[modId]!.interior.nodes.map((n) => n.kind);

  it("lifts `for k, v in items:` to a foreach with names and round-trips", () => {
    // The requests status_codes.py shape: `for code, titles in _codes.items()`.
    const { sys, py } = rt(
      "def f(items: list) -> None:\n    for k, v in items:\n        print(k)\n        print(v)\n",
    );
    expect(py).toContain("for k, v in items:");
    const node = sys.modules["f"]!.interior.nodes.find((n) => n.kind === "foreach")!;
    expect((node as { names?: string[] }).names).toEqual(["k", "v"]);
    expect(nodeKinds(sys, "f")).toContain("foreach");
  });

  it("binds each unpacked name independently inside the body", () => {
    const { py } = rt(
      "def f(pairs: list) -> None:\n    for a, b, c in pairs:\n        print(a)\n        print(c)\n",
    );
    expect(py).toContain("for a, b, c in pairs:");
  });

  it("cross-compiles a for-target unpack to TS array destructuring", () => {
    const sys = liftPython("def f(items: list) -> None:\n    for k, v in items:\n        print(k)\n");
    expect(transpile(sys, "ts")).toContain("for (const [k, v] of items) {");
  });

  it("refuses a starred for-target `for a, *rest in xs:` (deferred)", () => {
    expect(() => liftPython("def f(xs: list) -> None:\n    for a, *rest in xs:\n        print(a)\n")).toThrow(/starred unpack/);
  });

  it("refuses a nested for-target `for (a, b), c in xs:` (deferred)", () => {
    expect(() => liftPython("def f(xs: list) -> None:\n    for (a, b), c in xs:\n        print(c)\n")).toThrow(/nested unpack/);
  });
});

describe("lift: tuple unpacking round-trips from TypeScript (item 14)", () => {
  it("lifts `const [a, b] = f(x)` to an `unpack` node and is a fixed point", () => {
    const src = "export function g(x: number): number {\n  const [a, b] = parse(x);\n  return a;\n}\n";
    const sys = liftTypeScript(src);
    expect(validateSystem(sys).ok).toBe(true);
    const codeA = transpile(sys, "ts");
    expect(transpile(liftTypeScript(codeA), "ts")).toBe(codeA); // fixed point
    expect(codeA).toContain("const [a, b] = parse(x);");
    expect(sys.modules["g"]!.interior.nodes.map((n) => n.kind)).toContain("unpack");
  });

  it("refuses a rest element `const [a, ...rest] = xs` (deferred)", () => {
    expect(() =>
      liftTypeScript("export function g(xs: number[]): number {\n  const [a, ...rest] = xs;\n  return a;\n}\n"),
    ).toThrow(/rest element/);
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

describe.skipIf(!hasPython())("lift: Python while loop (item 16)", () => {
  const SRC = "def drain(q: list) -> None:\n    while has_next(q):\n        item = pop(q)\n        print(item)\n";

  it("lifts a while → while node and round-trips (Python)", () => {
    const sys = liftPython(SRC);
    expect(validateSystem(sys).ok).toBe(true);
    expect(sys.modules["drain"]!.interior.nodes.map((n) => n.kind)).toContain("while");
    const codeA = transpile(sys, "python");
    expect(codeA).toContain("while has_next(q):");
    expect(transpile(liftPython(codeA), "python")).toBe(codeA);
    // The same IR cross-compiles to a TS while.
    expect(transpile(sys, "ts")).toContain("while (hasNext(q)) {");
  });

  it("refuses a while/else (no IR node for the else clause)", () => {
    expect(() => liftPython("def f(q: list) -> None:\n    while go(q):\n        do(q)\n    else:\n        end()\n")).toThrow(/while\/else/);
  });
});

describe.skipIf(!hasPython())("lift: async / await (item 23)", () => {
  it("lifts `async def` + `await` and round-trips (Python); TS emits async", () => {
    const src = "async def fetch_all(urls: list) -> int:\n    return process(await gather(urls))\n";
    const sys = liftPython(src);
    expect(validateSystem(sys).ok).toBe(true);
    expect(sys.modules["fetch_all"]!.async).toBe(true);
    expect(sys.modules["fetch_all"]!.interior.nodes.map((n) => n.kind)).toContain("await");
    const py = transpile(sys, "python");
    expect(py).toContain("async def fetch_all");
    expect(py).toContain("await gather(urls)");
    expect(transpile(liftPython(py), "python")).toBe(py); // fixed point
    const ts = transpile(sys, "ts");
    expect(ts).toContain("export async function fetchAll");
    expect(ts).toContain("await gather(urls)");
  });

  it("round-trips async/await from TypeScript (symmetric)", () => {
    const src = "export async function load(u: string): number {\n  return parse(await get(u));\n}\n";
    const ts = transpile(liftTypeScript(src), "ts");
    expect(ts).toContain("export async function load");
    expect(ts).toContain("await get(u)");
    expect(transpile(liftTypeScript(ts), "ts")).toBe(ts); // fixed point
  });
});

describe.skipIf(!hasPython())("lift: yield / generators (item 22)", () => {
  const rtg = (src: string) => {
    const sys = liftPython(src);
    expect(validateSystem(sys).ok).toBe(true);
    const a = transpile(sys, "python");
    expect(transpile(liftPython(a), "python")).toBe(a); // Python fixed point
    return { sys, py: a };
  };

  it("lifts `yield value` in a loop and round-trips; TS emits a generator", () => {
    const { sys, py } = rtg("def gen(items: list) -> None:\n    for x in items:\n        yield process(x)\n");
    expect(py).toContain("yield process(x)");
    expect(sys.modules["gen"]!.interior.nodes.map((n) => n.kind)).toContain("yield");
    expect(transpile(sys, "ts")).toContain("export function* gen");
    expect(transpile(sys, "ts")).toContain("yield process(x);");
  });

  it("lifts `yield from` (delegation) and round-trips", () => {
    const { py } = rtg("def chain(a: list, b: list) -> None:\n    yield from a\n    yield from b\n");
    expect(py).toContain("yield from a");
    expect(transpile(liftPython(py), "ts")).toContain("yield* a;");
  });

  it("lifts a bare `yield` and round-trips", () => {
    const { py } = rtg("def ticks(n: int) -> None:\n    for i in range(0, n):\n        yield\n");
    expect(py).toContain("yield");
  });
});

describe.skipIf(!hasPython())("lift: keyword / star / dstar call args (item 12)", () => {
  const rt = (src: string) => {
    const sys = liftPython(src);
    expect(validateSystem(sys).ok).toBe(true);
    const a = transpile(sys, "python");
    expect(transpile(liftPython(a), "python")).toBe(a); // Python fixed point
    return { sys, py: a };
  };

  it("captures keyword args (previously silently dropped) and round-trips", () => {
    const { py } = rt("def request(method: str, url: str) -> int:\n    return send(method=method, url=url, timeout=30)\n");
    expect(py).toContain("send(method=method, url=url, timeout=30)");
  });

  it("captures *args, **kwargs, and mixed positional/keyword and round-trips", () => {
    const { py } = rt("def f(args: list, opts: dict) -> int:\n    return go(1, *args, x=2, **opts)\n");
    expect(py).toContain("go(1, *args, x=2, **opts)");
  });

  it("captures keyword args on a method call and round-trips", () => {
    const { py } = rt("def g(s: object) -> str:\n    return s.format(a=1, b=2)\n");
    expect(py).toContain("s.format(a=1, b=2)");
  });

  it("cross-compiles *x to a TS spread (one-way)", () => {
    const sys = liftPython("def f(args: list) -> int:\n    return go(1, *args)\n");
    expect(transpile(sys, "ts")).toContain("go(1, ...args)");
  });

  it("refuses *args unpacked into a sibling-function link (deferred)", () => {
    // A sequenced (statement-position) call to a sibling forms a link; a star
    // unpack into a link can't map to fixed param ports, so it refuses loudly.
    expect(() => liftPython("def helper(a: int, b: int) -> int:\n    return a + b\n\ndef caller(xs: list) -> int:\n    r = helper(*xs)\n    return r\n")).toThrow(/unpack into a call/);
  });
});

describe.skipIf(!hasPython())("lift: exceptions full — typed except / else / finally (item 20)", () => {
  const rt = (src: string) => {
    const sys = liftPython(src);
    expect(validateSystem(sys).ok).toBe(true);
    const a = transpile(sys, "python");
    expect(transpile(liftPython(a), "python")).toBe(a); // Python fixed point
    return { sys, py: a };
  };

  it("lifts a single typed `except E:` and round-trips", () => {
    const { sys, py } = rt("def f(u: str) -> bool:\n    try:\n        encode(u)\n        return True\n    except UnicodeEncodeError:\n        return False\n");
    expect(py).toContain("except UnicodeEncodeError:");
    const tryNode = sys.modules["f"]!.interior.nodes.find((n) => n.kind === "try")!;
    expect((tryNode as { errorTypes?: string[] }).errorTypes).toEqual(["UnicodeEncodeError"]);
  });

  it("lifts a tuple `except (A, B):` and round-trips", () => {
    const { sys, py } = rt("def g(x: int) -> int:\n    try:\n        return parse(x)\n    except (TypeError, AttributeError):\n        return 0\n");
    expect(py).toContain("except (TypeError, AttributeError):");
    const tryNode = sys.modules["g"]!.interior.nodes.find((n) => n.kind === "try")!;
    expect((tryNode as { errorTypes?: string[] }).errorTypes).toEqual(["TypeError", "AttributeError"]);
  });

  it("lifts a try/finally and round-trips", () => {
    const { py } = rt("def h(n: int) -> int:\n    try:\n        return risky(n)\n    except Exception as e:\n        log(e)\n        return 0\n    finally:\n        cleanup()\n");
    expect(py).toContain("finally:");
    expect(py).toContain("cleanup()");
  });

  it("lifts a try/else and round-trips", () => {
    const { py } = rt("def k(n: int) -> None:\n    try:\n        risky(n)\n    except Exception:\n        recover()\n    else:\n        ok(n)\n");
    expect(py).toContain("else:");
    expect(py).toContain("ok(n)");
  });

  it("typed except cross-compiles to a TS instanceof re-throw (one-way)", () => {
    const sys = liftPython("def f(u: str) -> bool:\n    try:\n        encode(u)\n        return True\n    except UnicodeEncodeError as e:\n        return False\n");
    expect(transpile(sys, "ts")).toContain("instanceof UnicodeEncodeError");
  });

  it("refuses a value merged across try/except arms (no merge node)", () => {
    expect(() => liftPython("def g() -> bool:\n    try:\n        x = parse()\n    except (TypeError, AttributeError):\n        x = True\n    return x\n")).toThrow(/merging a value across the try/);
  });

  it("refuses multiple separate except clauses (deferred)", () => {
    expect(() => liftPython("def f(n: int) -> None:\n    try:\n        go(n)\n    except TypeError:\n        a()\n    except ValueError:\n        b()\n")).toThrow(/multiple\/zero except handlers/);
  });

  it("lifts a dotted except type and a `pass` handler body, round-trips", () => {
    const { py } = rt("def f(lib: str) -> None:\n    try:\n        load(lib)\n    except (io.UnsupportedOperation, AttributeError):\n        pass\n");
    expect(py).toContain("except (io.UnsupportedOperation, AttributeError):");
    expect(py).toContain("pass");
  });
});

describe.skipIf(!hasPython())("lift: annotated assignment statement (item 21, slice A)", () => {
  const rt = (src: string) => {
    const sys = liftPython(src);
    expect(validateSystem(sys).ok).toBe(true);
    const a = transpile(sys, "python");
    expect(transpile(liftPython(a), "python")).toBe(a); // Python fixed point
    return { sys, py: a };
  };

  it("lifts a local `x: T = v` as a plain bind (annotation normalized away)", () => {
    const { py } = rt("def f(d: dict, key: str) -> int:\n    hook_list: list = d.get(key)\n    return count(hook_list)\n");
    expect(py).toContain("hook_list = d.get(key)");
    expect(py).not.toContain(": list");
  });

  it("lifts an annotated self-attribute write `self.x: T = v` as stateSet", () => {
    const { sys } = rt("class C:\n    def setup(self, n: int) -> None:\n        self.count: int = n\n");
    expect(sys.modules["C.setup"]!.interior.nodes.map((nn) => nn.kind)).toContain("stateSet");
  });

  it("refuses a bare annotation `x: T` (no value, forward declaration)", () => {
    expect(() => liftPython("def f() -> None:\n    x: int\n    print(x)\n")).toThrow(/bare annotation/);
  });
});

describe.skipIf(!hasPython())("lift: early/branch returns — multi-exit (item 18)", () => {
  const rt = (src: string) => {
    const sys = liftPython(src);
    expect(validateSystem(sys).ok).toBe(true);
    const a = transpile(sys, "python");
    expect(transpile(liftPython(a), "python")).toBe(a); // Python fixed point
    return { sys, py: a };
  };
  const returns = (sys: System, modId: string) =>
    sys.modules[modId]!.interior.nodes.filter((n) => n.kind === "return").length;

  it("lifts a guard clause with a side effect before the early return", () => {
    // Cannot collapse to a `cond` (the then-arm has an effect); needs real multi-exit.
    const { sys, py } = rt("def f(x: int) -> int:\n    if x < 0:\n        log(x)\n        return 0\n    return x\n");
    expect(returns(sys, "f")).toBe(2);
    expect(py).toContain("return 0");
    expect(py).toContain("return x");
  });

  it("lifts an early return from inside a loop", () => {
    const { sys, py } = rt("def find(items: list, target: int) -> int:\n    for x in items:\n        if x == target:\n            return x\n    return -1\n");
    expect(returns(sys, "find")).toBe(2);
    expect(py).toContain("return x");
    expect(py).toContain("return (-1)");
  });

  it("lifts a return nested in a with (the api.py shape) — no done port, no duplicate", () => {
    const { sys, py } = rt("def request(method: str, url: str) -> int:\n    with make_session() as session:\n        return send(session, method, url)\n");
    expect(returns(sys, "request")).toBe(1);
    expect(sys.modules["request"]!.ports.some((p) => p.name === "done")).toBe(false);
    expect(py).toContain("with make_session() as session:");
    expect((py.match(/return send/g) ?? []).length).toBe(1);
  });

  it("lifts a return inside a try/except (both arms return)", () => {
    const { sys } = rt("def g(x: int) -> int:\n    try:\n        return risky(x)\n    except Exception as e:\n        return fallback(e)\n");
    expect(returns(sys, "g")).toBe(2);
    expect(sys.modules["g"]!.ports.some((p) => p.name === "done")).toBe(false);
  });

  it("a value return wires to the out-port; callers still sequence (no done needed)", () => {
    const { py } = rt("def add(a: int, b: int) -> int:\n    return a + b\n\ndef run(x: int) -> int:\n    y = add(x, 1)\n    z = add(y, 2)\n    return z\n");
    expect(py).toContain("y = add(x, 1)");
    expect(py).toContain("z = add(y, 2)");
  });
});

describe.skipIf(!hasPython())("lift: break / continue (item 17)", () => {
  const nodeKinds = (sys: System, modId: string) =>
    sys.modules[modId]!.interior.nodes.map((n) => n.kind);

  it("lifts a trailing break → break node and round-trips (Python fixed point)", () => {
    const sys = liftPython("def f(items: list) -> None:\n    for x in items:\n        print(x)\n        break\n");
    expect(validateSystem(sys).ok).toBe(true);
    expect(nodeKinds(sys, "f")).toContain("break");
    const py = transpile(sys, "python");
    expect(py).toContain("break");
    expect(transpile(liftPython(py), "python")).toBe(py);
    expect(transpile(sys, "ts")).toContain("break;");
  });

  it("lifts a guarded continue and is a fixed point after the guard fold", () => {
    const sys = liftPython("def f(items: list) -> None:\n    for x in items:\n        if bad(x):\n            continue\n        print(x)\n");
    expect(nodeKinds(sys, "f")).toContain("continue");
    const py = transpile(sys, "python");
    expect(py).toContain("continue");
    // The guard fold rewrites `if c: continue` + rest into if/else; stable thereafter.
    expect(transpile(liftPython(py), "python")).toBe(py);
  });

  it("round-trips break / continue from TypeScript", () => {
    const src = "export function f(xs: number[]): void {\n  for (const x of xs) {\n    if (x > 0) {\n      continue;\n    }\n    break;\n  }\n}\n";
    const sys = liftTypeScript(src);
    expect(nodeKinds(sys, "f")).toContain("break");
    expect(nodeKinds(sys, "f")).toContain("continue");
    const ts = transpile(sys, "ts");
    expect(ts).toContain("continue;");
    expect(ts).toContain("break;");
  });

  it("refuses a labeled break (no IR node)", () => {
    expect(() =>
      liftTypeScript("export function f(xs: number[]): void {\n  outer: for (const x of xs) {\n    break outer;\n  }\n}\n"),
    ).toThrow();
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

  it("lifts try/finally and round-trips from TypeScript (item 20)", () => {
    const src = [
      "export function risky(n: number): void {",
      "  try {",
      "    console.log(n);",
      "  } catch (e) {",
      "    console.log(e);",
      "  } finally {",
      "    console.log(0);",
      "  }",
      "}",
    ].join("\n");
    const sys = liftTypeScript(src);
    const ts = transpile(sys, "ts");
    expect(ts).toContain("} finally {");
    expect(transpile(liftTypeScript(ts), "ts")).toBe(ts); // fixed point
  });

  it("lifts a for-of with a [a, b] destructuring binding (item 14B) and round-trips", () => {
    const src = [
      "export function f(pairs: number[][]): void {",
      "  for (const [a, b] of pairs) {",
      "    console.log(a);",
      "  }",
      "}",
    ].join("\n");
    const sys = liftTypeScript(src);
    const node = sys.modules["f"]!.interior.nodes.find((n) => n.kind === "foreach")!;
    expect((node as { names?: string[] }).names).toEqual(["a", "b"]);
    expect(transpile(sys, "ts")).toContain("for (const [a, b] of pairs) {");
  });

  it("lifts a guarded early return (multi-exit, item 18) and round-trips from TS", () => {
    const src = [
      "export function f(x: number): number {",
      "  if (x < 0) {",
      "    console.log(x);",
      "    return 0;",
      "  }",
      "  return x;",
      "}",
    ].join("\n");
    const sys = liftTypeScript(src);
    expect(sys.modules["f"]!.interior.nodes.filter((n) => n.kind === "return").length).toBe(2);
    const ts = transpile(sys, "ts");
    expect(ts).toContain("return 0;");
    expect(ts).toContain("return x;");
    expect(transpile(liftTypeScript(ts), "ts")).toBe(ts); // fixed point
  });
});

// Roadmap item 7: method/attribute access on self & locals. Today only
// imported-base member calls lifted; real OO needs `self.foo()`, `obj.bar()`,
// and general attribute reads `obj.attr`. A method call becomes a `method` node
// (receiver wired on pin "recv", or AMBIENT — no wire — when the receiver is
// self/this); an attribute read becomes an `attrGet` node. Bare `self`/`this`
// values and reads off an imported name stay refused (deferred constructs).
describe.skipIf(!hasPython())("lift: method & attribute access on self/locals (Python)", () => {
  const roundtrips = (src: string) => {
    const sys = liftPython(src);
    expect(validateSystem(sys).ok).toBe(true);
    const codeA = transpile(sys, "python");
    expect(transpile(liftPython(codeA), "python")).toBe(codeA); // fixed point
    return { sys, codeA };
  };
  const nodeKinds = (sys: System, modId: string) =>
    sys.modules[modId]!.interior.nodes.map((n) => n.kind);

  it("a self method call is a `method` node with no receiver wire", () => {
    const { sys, codeA } = roundtrips(
      "class C:\n    def greet(self, x: str) -> str:\n        msg = self.fmt(x)\n        return msg\n\n    def fmt(self, x: str) -> str:\n        return x\n",
    );
    expect(codeA).toContain("msg = self.fmt(x)");
    const greet = sys.modules["C.greet"]!;
    const method = greet.interior.nodes.find((n) => n.kind === "method");
    expect(method).toBeDefined();
    expect((method as { label: string }).label).toBe("fmt");
    // The ambient self receiver carries NO `:recv` wire — only the arg `x`.
    const recvWire = greet.interior.wires.find(([, to]) => to === `${method!.id}:recv`);
    expect(recvWire).toBeUndefined();
  });

  it("a method call on a local wires the receiver on pin `recv`", () => {
    const { sys, codeA } = roundtrips(
      "def f(target: str) -> str:\n    out = target.upper()\n    return out\n",
    );
    expect(codeA).toContain("out = target.upper()");
    const method = sys.modules["f"]!.interior.nodes.find((n) => n.kind === "method")!;
    const recvWire = sys.modules["f"]!.interior.wires.find(([, to]) => to === `${method.id}:recv`);
    expect(recvWire).toBeDefined();
  });

  it("round-trips a chained method call", () => {
    const { codeA } = roundtrips("def f(s: str) -> str:\n    return s.strip().lower()\n");
    expect(codeA).toContain("return s.strip().lower()");
  });

  it("a general attribute read is an `attrGet` node and round-trips", () => {
    const { sys, codeA } = roundtrips("def f(resp: str) -> str:\n    return resp.status\n");
    expect(codeA).toContain("return resp.status");
    expect(nodeKinds(sys, "f")).toContain("attrGet");
  });

  it("round-trips a method call on a self attribute (stateGet receiver)", () => {
    const { codeA } = roundtrips(
      "class C:\n    def f(self, url: str) -> str:\n        r = self.session.get(url)\n        return r\n",
    );
    expect(codeA).toContain("r = self.session.get(url)");
  });

  it("round-trips an effectful method-call statement", () => {
    const { codeA } = roundtrips("def f(items: str) -> None:\n    items.append(1)\n");
    expect(codeA).toContain("items.append(1)");
  });

  it("round-trips a method call in argument position", () => {
    const { codeA } = roundtrips("def f(obj: str) -> str:\n    return helper(obj.name())\n");
    expect(codeA).toContain("return helper(obj.name())");
  });

  it("refuses a bare `self` value (no IR source yet)", () => {
    const src = "class C:\n    def f(self) -> None:\n        sink(self)\n";
    expect(() => transpile(liftPython(src), "python")).toThrow(/bare "self"\/"this"/);
  });

  it("refuses an attribute read on an imported name (package value reference)", () => {
    const src = "import sys\ndef f() -> int:\n    return sys.maxsize\n";
    expect(() => liftPython(src)).toThrow();
  });

  it("lifts a bare `return` (void early exit, item 18) and round-trips", () => {
    const src = "def f(x: int) -> None:\n    if x > 0:\n        do(x)\n        return\n    other(x)\n";
    const sys = liftPython(src);
    expect(validateSystem(sys).ok).toBe(true);
    expect(sys.modules["f"]!.interior.nodes.filter((n) => n.kind === "return").length).toBe(1);
    const py = transpile(sys, "python");
    expect(py).toMatch(/\breturn\b/);
    expect(transpile(liftPython(py), "python")).toBe(py);
  });
});

describe("lift: method & attribute access on self/locals (TS)", () => {
  const roundtrips = (src: string) => {
    const sys = liftTypeScript(src);
    expect(validateSystem(sys).ok).toBe(true);
    const codeA = transpile(sys, "ts");
    expect(transpile(liftTypeScript(codeA), "ts")).toBe(codeA); // fixed point
    return { sys, codeA };
  };

  it("a `this` method call is a `method` node with no receiver wire", () => {
    const { sys, codeA } = roundtrips(
      "export class C {\n  greet(x: string): string {\n    return this.fmt(x);\n  }\n\n  fmt(x: string): string {\n    return x;\n  }\n}\n",
    );
    expect(codeA).toContain("return this.fmt(x);");
    const greet = sys.modules["C.greet"]!;
    const method = greet.interior.nodes.find((n) => n.kind === "method")!;
    expect((method as { label: string }).label).toBe("fmt");
    expect(greet.interior.wires.find(([, to]) => to === `${method.id}:recv`)).toBeUndefined();
  });

  it("classifies a method call on a bound local and wires the receiver", () => {
    const { sys, codeA } = roundtrips(
      "export function f(obj: string): string {\n  const x = obj.toUpperCase();\n  return x;\n}\n",
    );
    expect(codeA).toContain("const x = obj.toUpperCase();");
    const method = sys.modules["f"]!.interior.nodes.find((n) => n.kind === "method")!;
    expect(sys.modules["f"]!.interior.wires.find(([, to]) => to === `${method.id}:recv`)).toBeDefined();
  });

  it("round-trips a general attribute read", () => {
    const { sys, codeA } = roundtrips("export function f(resp: string): string {\n  return resp.status;\n}\n");
    expect(codeA).toContain("return resp.status;");
    expect(sys.modules["f"]!.interior.nodes.map((n) => n.kind)).toContain("attrGet");
  });

  it("round-trips a chained method call", () => {
    const { codeA } = roundtrips("export function f(s: string): string {\n  return s.trim().toLowerCase();\n}\n");
    expect(codeA).toContain("return s.trim().toLowerCase();");
  });

  it("refuses a bare `this` value (no IR source yet)", () => {
    const src = "export class C {\n  f(): void {\n    sink(this);\n  }\n}\n";
    expect(() => transpile(liftTypeScript(src), "ts")).toThrow(/bare "self"\/"this"/);
  });
});

describe.skipIf(!hasPython())("lift: with statement & assert (item 15, Python)", () => {
  const rt = (src: string) => {
    const sys = liftPython(src);
    expect(validateSystem(sys).ok).toBe(true);
    const a = transpile(sys, "python");
    expect(transpile(liftPython(a), "python")).toBe(a); // Python fixed point
    return { sys, py: a };
  };
  const nodeKinds = (sys: System, modId: string) =>
    sys.modules[modId]!.interior.nodes.map((n) => n.kind);

  it("lifts `with ctx as r:` to a with node and round-trips", () => {
    const { sys, py } = rt(
      "def run(name: str) -> int:\n    with make(name) as f:\n        x = read(f)\n    return x\n",
    );
    expect(py).toContain("with make(name) as f:");
    expect(py).toContain("x = read(f)");
    const node = sys.modules["run"]!.interior.nodes.find((n) => n.kind === "with")!;
    expect(node.label).toBe("f");
    expect(nodeKinds(sys, "run")).toContain("with");
  });

  it("lifts a with WITHOUT an `as` binding and round-trips", () => {
    const { sys, py } = rt(
      "def silent(name: str) -> None:\n    with lock():\n        do(name)\n",
    );
    expect(py).toContain("with lock():");
    expect(sys.modules["silent"]!.interior.nodes.find((n) => n.kind === "with")!.label).toBe("");
  });

  it("cross-compiles a with to a TS `using` disposable block (one-way)", () => {
    const sys = liftPython("def run(name: str) -> None:\n    with make(name) as f:\n        do(f)\n");
    const ts = transpile(sys, "ts");
    expect(ts).toContain("using f = make(name);");
  });

  it("lifts `assert cond, message` and round-trips", () => {
    const { sys, py } = rt(
      'def check(n: int) -> None:\n    assert n > 0, "must be positive"\n',
    );
    expect(py).toContain('assert (n > 0), "must be positive"');
    expect(nodeKinds(sys, "check")).toContain("assert");
  });

  it("lifts a bare `assert cond` (no message) and round-trips", () => {
    const { py } = rt("def check(ok: bool) -> None:\n    assert ok\n");
    expect(py).toContain("assert ok");
    expect(py).not.toContain(",");
  });

  it("cross-compiles assert to `console.assert` (one-way)", () => {
    const sys = liftPython('def check(n: int) -> None:\n    assert n > 0, "bad"\n');
    expect(transpile(sys, "ts")).toContain('console.assert((n > 0), "bad");');
  });

  it("refuses multiple context managers `with a, b:` (deferred)", () => {
    expect(() => liftPython("def f() -> None:\n    with a() as x, b() as y:\n        do(x)\n")).toThrow(/multiple context managers/);
  });

  it("refuses a non-name with-target (deferred)", () => {
    expect(() => liftPython("def f(d: dict) -> None:\n    with mgr() as d.x:\n        do(d)\n")).toThrow(/with-target/);
  });
});
