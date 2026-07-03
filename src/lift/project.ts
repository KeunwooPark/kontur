/**
 * Multi-file project driver: lift a set of source files into ONE Kontur
 * `System`. The IR is already a single map of modules keyed by id, so "multi
 * file" means *more modules in one System* — each tagged with the `origin` file
 * it came from, and its id qualified by that file's path so two files can each
 * define a `helper` without colliding.
 *
 * The payoff is cross-file navigation: a call into another project file resolves
 * to a descendable `module` link (not a dashed boundary box), while a call into
 * a third-party package stays an external crossing. The link/external decision
 * lives in `resolve.ts`; this module wires its answers into each file's lift.
 *
 * Two discovery modes share one assembler (`assemble`):
 *   - `liftProject` — entry-driven: seed from entry files, follow their local
 *     imports transitively, fail loud on any unsupported file. Features are the
 *     entries' declarations.
 *   - `liftDirectory` — walk a tree, lift what fits the subset and report what
 *     doesn't (never silently), and make the unreferenced modules the features.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import type { Program } from "../transpile/ast.js";
import type { System } from "../ir/schema.js";
import { parseTypeScript } from "./ast-from-ts.js";
import { parsePython } from "./ast-from-python.js";
import { liftProgram, ctorParamNames, type LiftContext, type LocalImportTarget } from "./to-ir.js";
import { validateSystem } from "../ir/validate.js";
import { langOf, resolveLocalImport } from "./resolve.js";

export interface ProjectOptions {
  /** Absolute project root; `origin`/module-key paths are relative to it. */
  root: string;
  /** Absolute entry file paths. Their top-level declarations become the System's features. */
  entries: string[];
  /**
   * Absolute paths to lift in addition to the entries and whatever the entries
   * import. A directory walk passes every project file here; entry-driven lifts
   * omit it and discover files by following imports.
   */
  seed?: string[];
}

/** A file the directory walk could not lift, with the loud reason it was skipped. */
export interface SkippedFile {
  /** Project-relative path. */
  file: string;
  /** "parse" if the front-end rejected it, "lift" if it left the supported subset. */
  phase: "parse" | "lift";
  message: string;
}

export interface DirectoryResult {
  system: System;
  /** Files left out of the System, reported so coverage is never silently lossy. */
  skipped: SkippedFile[];
}

/** Lift a project (entries + reachable/seeded files) into one merged System. */
export function liftProject(opts: ProjectOptions): System {
  const { root, entries } = opts;
  const seed = opts.seed ?? [];

  // Parse every reachable file, following local imports from the entries. Strict:
  // a parse/lift failure propagates — an entry-driven lift is all-or-nothing.
  const programs = new Map<string, Program>();
  const worklist = [...entries, ...seed];
  while (worklist.length > 0) {
    const abs = worklist.pop()!;
    if (programs.has(abs)) continue;
    const program = parseFile(abs);
    programs.set(abs, program);
    for (const target of localImportTargets(program, abs)) {
      if (!programs.has(target)) worklist.push(target);
    }
  }

  const liftable = new Set(programs.keys());
  const { modules, imports, featuresByFile } = assemble(root, programs, liftable);
  // Only the entry files seed the navigation tree; everything else is reached by
  // descending links.
  const features = entries.flatMap((abs) => featuresByFile.get(abs) ?? []);

  const system: System = { features, modules };
  if (imports.length > 0) system.imports = imports;
  return system;
}

/**
 * Lift every supported source file under `root` into one System. Unlike the
 * entry-driven `liftProject`, this is tolerant: a file the lifter rejects is
 * SKIPPED and reported (never silently dropped — that would be the lossy lie the
 * manifesto forbids), and a call into a skipped file degrades to a stub rather
 * than a dangling link. Features are the navigation roots — modules no other
 * module links to.
 */
export function liftDirectory(root: string, opts: { exclude?: (rel: string) => boolean } = {}): DirectoryResult {
  const skipped: SkippedFile[] = [];

  // 1. Parse every walked file; a parse failure is skipped, not fatal.
  const programs = new Map<string, Program>();
  for (const abs of walkSources(root, opts.exclude)) {
    try {
      programs.set(abs, parseFile(abs));
    } catch (err) {
      skipped.push({ file: moduleOrigin(root, abs), phase: "parse", message: (err as Error).message });
    }
  }

  // 2. Determine which files actually lift. A file's liftability is independent of
  //    its imports, so a trial lift (bare context) is a faithful predictor — and
  //    computing it up front means cross-file links only ever target liftable
  //    files, so a skipped file can't leave a dangling ref behind.
  const liftable = new Set<string>();
  for (const [abs, program] of programs) {
    try {
      const trial = liftProgram(program, { origin: moduleOrigin(root, abs), moduleKey: moduleKey(root, abs) });
      // A trial lift must also be STRUCTURALLY VALID: a file that lowers without
      // throwing but produces invalid IR (e.g. duplicate method ids from @overload
      // stubs) must be skipped loudly, never silently assembled into the System —
      // the manifesto forbids presenting a lie as a lifted file.
      const v = validateSystem(trial);
      if (!v.ok) throw new Error(`invalid IR: ${v.issues[0]?.message ?? "failed validation"}`);
      liftable.add(abs);
    } catch (err) {
      skipped.push({ file: moduleOrigin(root, abs), phase: "lift", message: (err as Error).message });
    }
  }

  // 3. Assemble the liftable set, then root the navigation at the unreferenced modules.
  const { modules, imports } = assemble(root, programs, liftable);
  const features = computeRoots(modules);

  const system: System = { features, modules };
  if (imports.length > 0) system.imports = imports;
  return { system, skipped };
}

/**
 * Lower the `liftable` subset of `programs` into merged modules + imports. Shared
 * by both drivers; the only thing they decide differently is which modules become
 * features, so this returns the per-file feature lists rather than picking.
 */
function assemble(
  root: string,
  programs: Map<string, Program>,
  liftable: Set<string>,
): { modules: System["modules"]; imports: NonNullable<System["imports"]>; featuresByFile: Map<string, string[]> } {
  // Index the liftable files' top-level declaration names (so an import can only
  // link to a symbol that file actually defines) and every function's params
  // keyed by qualified id (so a cross-file link wires its args by the callee's
  // port names — which the callee's own file alone can't tell the caller). Built
  // from the liftable set only, so links never point at a skipped file.
  const declsByFile = new Map<string, Set<string>>();
  const moduleParams = new Map<string, string[]>();
  for (const abs of liftable) {
    const program = programs.get(abs)!;
    declsByFile.set(abs, new Set<string>([
      ...program.functions.map((f) => f.name),
      ...program.classes.map((c) => c.name),
    ]));
    const key = moduleKey(root, abs);
    for (const f of program.functions) moduleParams.set(`${key}#${f.name}`, f.params.map((p) => p.name));
    // A class links as a constructor: register its `__init__`/`constructor` params
    // under the class id so a cross-file instantiation wires its args by those ports.
    for (const c of program.classes) moduleParams.set(`${key}#${c.name}`, ctorParamNames(c));
  }

  const modules: System["modules"] = {};
  const imports: NonNullable<System["imports"]> = [];
  const featuresByFile = new Map<string, string[]>();
  for (const abs of liftable) {
    const program = programs.get(abs)!;
    const { localImports, externalImports } = classifyImports(program, abs, root, declsByFile);
    const ctx: LiftContext = {
      origin: moduleOrigin(root, abs),
      moduleKey: moduleKey(root, abs),
      localImports,
      externalImports,
      moduleParams,
    };
    const partial = liftProgram(program, ctx);
    Object.assign(modules, partial.modules);
    if (partial.imports) imports.push(...partial.imports);
    featuresByFile.set(abs, partial.features);
  }
  return { modules, imports, featuresByFile };
}

/**
 * The navigation roots of a merged System: modules no other module links to.
 * Methods are linked from their class, free functions from their callers, and a
 * class from wherever it is instantiated — so "unreferenced" leaves the true
 * SURFACES: entry-point functions plus any class nothing constructs in-project
 * (genuinely external-facing API). A class used internally gains an in-edge and
 * drops out of the roots, reached by descending into the function that builds it.
 * If everything is referenced (e.g. a pure import cycle), fall back to all
 * non-method modules so nothing is unreachable.
 */
function computeRoots(modules: System["modules"]): string[] {
  const referenced = new Set<string>();
  for (const mod of Object.values(modules)) {
    for (const node of mod.interior.nodes) {
      if (node.kind === "module") referenced.add(node.ref);
    }
  }
  const roots = Object.keys(modules).filter((id) => !referenced.has(id));
  if (roots.length > 0) return roots;
  // Degenerate all-referenced graph: every non-method module is still a valid root.
  return Object.keys(modules).filter((id) => !isMethodId(id));
}

/** A method module id is `${classId}.${method}` — qualified class id plus a dotted method. */
function isMethodId(id: string): boolean {
  const bare = id.slice(id.lastIndexOf("#") + 1);
  return bare.includes(".");
}

/** Parse one file to the neutral AST, choosing the front-end by extension. */
function parseFile(abs: string): Program {
  const source = readFileSync(abs, "utf8");
  return langOf(abs) === "py" ? parsePython(source) : parseTypeScript(source);
}

/** The in-project files a program imports (absolute paths), ignoring packages. */
function localImportTargets(program: Program, importerAbs: string): string[] {
  const lang = langOf(importerAbs);
  const out: string[] = [];
  for (const imp of program.imports ?? []) {
    const target = resolveLocalImport(imp.source, importerAbs, lang);
    if (target) out.push(target);
  }
  return out;
}

/**
 * Classify one file's imports into the two maps the lifter consumes:
 *   - `localImports`: bindings that resolve to a liftable in-project module, so
 *     the call becomes a descendable link. A named import binds straight to the
 *     imported function's qualified id (when the target declares it); a namespace
 *     import binds the local name to the target's file so a `ns.member()` call is
 *     qualified at the use site.
 *   - `externalImports`: bindings from a third-party package (a specifier that
 *     does not resolve to a project file), so the call is tagged `source`.
 *
 * A binding that resolves to a local file we could NOT lift (not in `declsByFile`)
 * lands in NEITHER map: its call degrades to a plain stub — honest about the
 * boundary without faking a link to a missing module or a package that isn't one.
 */
function classifyImports(
  program: Program,
  importerAbs: string,
  root: string,
  declsByFile: Map<string, Set<string>>,
): { localImports: Map<string, LocalImportTarget>; externalImports: Map<string, string> } {
  const lang = langOf(importerAbs);
  const localImports = new Map<string, LocalImportTarget>();
  const externalImports = new Map<string, string>();
  for (const imp of program.imports ?? []) {
    const targetAbs = resolveLocalImport(imp.source, importerAbs, lang);
    if (!targetAbs) {
      // Bare specifier → third-party package: every binding is an external crossing.
      for (const b of imp.bindings) externalImports.set(b.local, imp.source);
      continue;
    }
    const decls = declsByFile.get(targetAbs);
    if (!decls) continue; // local file, but not liftable → stubs (neither link nor package)
    const targetKey = moduleKey(root, targetAbs);
    for (const b of imp.bindings) {
      if (b.kind === "named") {
        // Link only to a symbol the target actually declares; otherwise leave it
        // unresolved (a stub), never invent a link to a missing module.
        if (decls.has(b.imported)) localImports.set(b.local, { kind: "function", id: `${targetKey}#${b.imported}` });
      } else if (b.kind === "namespace") {
        localImports.set(b.local, { kind: "namespace", moduleKey: targetKey });
      }
      // `default`: a local default import has no package-side name to resolve to
      // a declaration — left unresolved (a stub) until default exports are modelled.
    }
  }
  return { localImports, externalImports };
}

/** Directory names never walked into (build output, deps, VCS, hidden dirs). */
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", "coverage", ".git"]);

/**
 * Recursively collect liftable source files under `root` (`.ts`/`.tsx`/`.py`),
 * skipping build/dep directories, hidden entries, declaration files, and test
 * files (which lean on test-runner imports outside the subset). `exclude` can
 * drop further project-relative paths.
 */
function walkSources(root: string, exclude?: (rel: string) => boolean): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) visit(abs);
        continue;
      }
      if (!/\.(ts|tsx|py)$/.test(entry.name)) continue;
      if (/\.d\.ts$/.test(entry.name)) continue;
      if (/\.(test|spec)\.(ts|tsx|py)$/.test(entry.name) || /(^|[_])test_.*\.py$|_test\.py$/.test(entry.name)) continue;
      const rel = moduleOrigin(root, abs);
      if (exclude?.(rel)) continue;
      out.push(abs);
    }
  };
  visit(root);
  return out;
}

/** Project-relative source path (POSIX), e.g. "src/util.ts" — stamped as `origin`. */
function moduleOrigin(root: string, abs: string): string {
  return relative(root, abs).split("\\").join("/");
}

/** Project-relative path without extension, e.g. "src/util" — the id qualifier. */
function moduleKey(root: string, abs: string): string {
  return moduleOrigin(root, abs).replace(/\.[^.]+$/, "");
}
