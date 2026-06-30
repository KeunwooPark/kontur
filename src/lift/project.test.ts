import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateSystem } from "../ir/index.js";
import { transpileProject } from "../transpile/index.js";
import { liftProject, liftDirectory } from "./index.js";
import type { Node } from "../ir/schema.js";

function hasPython(): boolean {
  try { execFileSync("python3", ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
}

/** Write a `{ relPath: source }` project under a fresh temp root; return the root. */
function writeProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "kontur-proj-"));
  for (const [rel, src] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, src);
  }
  return root;
}

describe("liftProject: cross-file calls become descendable links", () => {
  const FILES = {
    "src/util.ts": "export function double(x: number): number {\n  return x * 2;\n}\n",
    "src/main.ts": [
      'import { double } from "./util";',
      'import { chunk } from "lodash";',
      "",
      "export function run(n: number): void {",
      "  const d = double(n);",
      "  const groups = chunk(d, 2);",
      "  console.log(groups);",
      "}",
      "",
    ].join("\n"),
  };

  it("merges files into one System with path-qualified ids", () => {
    const root = writeProject(FILES);
    const sys = liftProject({ root, entries: [join(root, "src/main.ts")] });
    expect(validateSystem(sys).ok).toBe(true);
    expect(Object.keys(sys.modules).sort()).toEqual(["src/main#run", "src/util#double"]);
    // Only the entry file's declarations are features (navigation roots).
    expect(sys.features).toEqual(["src/main#run"]);
    // Every module records the file it was lifted from.
    expect(sys.modules["src/main#run"]!.origin).toBe("src/main.ts");
    expect(sys.modules["src/util#double"]!.origin).toBe("src/util.ts");
  });

  it("links a local import but keeps a package import an external crossing", () => {
    const root = writeProject(FILES);
    const sys = liftProject({ root, entries: [join(root, "src/main.ts")] });
    const nodes = sys.modules["src/main#run"]!.interior.nodes;

    // The call into ./util is a descendable module link to the resolved module id.
    const link = nodes.find((n): n is Extract<Node, { kind: "module" }> => n.kind === "module");
    expect(link?.ref).toBe("src/util#double");

    // The call into lodash stays a `function` node tagged with its package.
    const ext = nodes.find(
      (n): n is Extract<Node, { kind: "function" }> => n.kind === "function" && "source" in n && n.source !== undefined,
    );
    expect(ext?.label).toBe("chunk");
    expect((ext as { source?: string }).source).toBe("lodash");
  });

  it("transpiles back to per-file sources, preserving the import boundary", () => {
    const root = writeProject(FILES);
    const sys = liftProject({ root, entries: [join(root, "src/main.ts")] });
    const out = transpileProject(sys, "ts");

    expect(out.get("src/util.ts")).toContain("export function double(x: number): number {");
    const main = out.get("src/main.ts")!;
    expect(main).toContain('import { double } from "./util";'); // the link's import line is reproduced
    expect(main).toContain("const d = double(n);"); // the cross-file call by its bare name
    expect(main).toContain('import { chunk } from "lodash";'); // the package boundary survives
  });

  it("re-lifting the emitted project is a fixed point", () => {
    const root = writeProject(FILES);
    const sys = liftProject({ root, entries: [join(root, "src/main.ts")] });
    const out = transpileProject(sys, "ts");

    // Write the regenerated sources back out and lift again — same code in, same code out.
    const root2 = writeProject({
      "src/util.ts": out.get("src/util.ts")!,
      "src/main.ts": out.get("src/main.ts")!,
    });
    const sys2 = liftProject({ root: root2, entries: [join(root2, "src/main.ts")] });
    expect(validateSystem(sys2).ok).toBe(true);
    const out2 = transpileProject(sys2, "ts");
    expect(out2.get("src/main.ts")).toBe(out.get("src/main.ts"));
    expect(out2.get("src/util.ts")).toBe(out.get("src/util.ts"));
  });
});

describe("liftProject: aliased & namespaced local imports round-trip (the alias gap)", () => {
  it("an import alias links correctly and re-emits the alias, not the declared name", () => {
    const root = writeProject({
      "src/util.ts": "export function double(x: number): number {\n  return x * 2;\n}\n",
      "src/main.ts": [
        'import { double as d2 } from "./util";',
        "",
        "export function run(n: number): void {",
        "  const r = d2(n);",
        "  console.log(r);",
        "}",
        "",
      ].join("\n"),
    });
    const sys = liftProject({ root, entries: [join(root, "src/main.ts")] });
    expect(validateSystem(sys).ok).toBe(true);

    // The link resolves to the real module, and records the call-site alias.
    const link = sys.modules["src/main#run"]!.interior.nodes.find(
      (n): n is Extract<Node, { kind: "module" }> => n.kind === "module",
    );
    expect(link?.ref).toBe("src/util#double");
    expect(link?.call).toBe("d2");

    // Emit uses the alias `d2(...)`, matching the verbatim `as d2` import — not `double(...)`.
    const main = transpileProject(sys, "ts").get("src/main.ts")!;
    expect(main).toContain("import { double as d2 } from \"./util\";");
    expect(main).toContain("const r = d2(n);");
    expect(main).not.toContain("double(n)");
  });

  it("a namespaced local import re-emits the `ns.member` call verbatim", () => {
    const root = writeProject({
      "src/util.ts": "export function double(x: number): number {\n  return x * 2;\n}\n",
      "src/main.ts": [
        'import * as util from "./util";',
        "",
        "export function run(n: number): void {",
        "  const r = util.double(n);",
        "  console.log(r);",
        "}",
        "",
      ].join("\n"),
    });
    const sys = liftProject({ root, entries: [join(root, "src/main.ts")] });
    expect(validateSystem(sys).ok).toBe(true);

    const link = sys.modules["src/main#run"]!.interior.nodes.find(
      (n): n is Extract<Node, { kind: "module" }> => n.kind === "module",
    );
    expect(link?.ref).toBe("src/util#double"); // member resolved to the target module
    expect(link?.call).toBe("util.double");

    const main = transpileProject(sys, "ts").get("src/main.ts")!;
    expect(main).toContain('import * as util from "./util";');
    expect(main).toContain("const r = util.double(n);"); // dotted access preserved, not mangled
  });
});

describe("liftDirectory: walk a tree, root the nav, report skips", () => {
  it("lifts every supported file and roots features at unreferenced modules", () => {
    const root = writeProject({
      "util.ts": "export function double(x: number): number {\n  return x * 2;\n}\n",
      "main.ts": [
        'import { double } from "./util";',
        "",
        "export function run(n: number): void {",
        "  const d = double(n);",
        "  console.log(d);",
        "}",
        "",
      ].join("\n"),
    });
    const { system, skipped } = liftDirectory(root);
    expect(validateSystem(system).ok).toBe(true);
    expect(skipped).toEqual([]);
    expect(Object.keys(system.modules).sort()).toEqual(["main#run", "util#double"]);
    // `run` calls `double`, so `double` is referenced; `run` is the only root.
    expect(system.features).toEqual(["main#run"]);
    // The cross-file call is still a descendable link.
    const link = system.modules["main#run"]!.interior.nodes.find(
      (n): n is Extract<Node, { kind: "module" }> => n.kind === "module",
    );
    expect(link?.ref).toBe("util#double");
  });

  it("skips an unsupported file loudly and degrades a call into it to a stub (no dangling link)", () => {
    const root = writeProject({
      // Out of subset: a post-branch control-flow merge → lift rejects it.
      "bad.ts": "export function bad(n: number): void {\n  if (n < 0) {\n    console.log(0);\n  }\n  console.log(n);\n}\n",
      "main.ts": [
        'import { bad } from "./bad";',
        "",
        "export function run(n: number): void {",
        "  bad(n);",
        "  console.log(n);",
        "}",
        "",
      ].join("\n"),
    });
    const { system, skipped } = liftDirectory(root);

    // The bad file is reported, not silently dropped, and never enters the System.
    expect(skipped.map((s) => s.file)).toEqual(["bad.ts"]);
    expect(skipped[0]!.phase).toBe("lift");
    expect(system.modules["bad#bad"]).toBeUndefined();

    // The System still validates — the call into the skipped file became a stub
    // `function` node (no `source`, no link), so there is no dangling ref.
    expect(validateSystem(system).ok).toBe(true);
    const nodes = system.modules["main#run"]!.interior.nodes;
    expect(nodes.some((n) => n.kind === "module")).toBe(false);
    const stub = nodes.find(
      (n): n is Extract<Node, { kind: "function" }> => n.kind === "function" && n.label === "bad",
    );
    expect(stub).toBeDefined();
    expect((stub as { source?: string }).source).toBeUndefined();
  });

  it("does not walk into node_modules or pick up test/declaration files", () => {
    const root = writeProject({
      "keep.ts": "export function keep(): void {\n  console.log(1);\n}\n",
      "keep.test.ts": "export function shouldBeIgnored(): void {\n  console.log(2);\n}\n",
      "types.d.ts": "export function alsoIgnored(): void;\n",
      "node_modules/dep/index.ts": "export function vendored(): void {\n  console.log(3);\n}\n",
    });
    const { system } = liftDirectory(root);
    expect(Object.keys(system.modules)).toEqual(["keep#keep"]);
  });
});

describe.skipIf(!hasPython())("liftProject: Python sibling imports", () => {
  const FILES = {
    "util.py": "def double(x: int) -> int:\n    return x * 2\n",
    "main.py": [
      "from util import double",
      "",
      "",
      "def run(n: int) -> None:",
      "    d = double(n)",
      "    print(d)",
      "",
    ].join("\n"),
  };

  it("links `from util import double` to the util module and round-trips", () => {
    const root = writeProject(FILES);
    const sys = liftProject({ root, entries: [join(root, "main.py")] });
    expect(validateSystem(sys).ok).toBe(true);
    expect(Object.keys(sys.modules).sort()).toEqual(["main#run", "util#double"]);

    const link = sys.modules["main#run"]!.interior.nodes.find(
      (n): n is Extract<Node, { kind: "module" }> => n.kind === "module",
    );
    expect(link?.ref).toBe("util#double");

    const out = transpileProject(sys, "python");
    expect(out.get("main.py")).toContain("from util import double");
    expect(out.get("main.py")).toContain("d = double(n)");
    expect(out.get("util.py")).toContain("def double(x: int) -> int:");
  });
});
