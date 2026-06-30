/**
 * Import resolution for the multi-file driver: decide whether an import
 * specifier points at another file *in this project* (a local import — which
 * lifts to a descendable module link) or at a third-party package (an external
 * import — which stays a boundary crossing).
 *
 * Resolution is filesystem-based and deliberately conservative: a specifier is
 * local only when it resolves to a file that actually exists on disk. Anything
 * unresolved is treated as external rather than guessed at — the same
 * fail-safe-not-sorry discipline the lifters use.
 */
import { existsSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";

export type Lang = "ts" | "py";

/** The language a source path is lifted as, inferred from its extension. */
export function langOf(path: string): Lang {
  return path.endsWith(".py") ? "py" : "ts";
}

/**
 * Resolve an import `specifier` written in `importerAbs` to the absolute path of
 * a project file, or undefined when it is not a local file (a bare package
 * specifier, or a relative path with no matching file).
 */
export function resolveLocalImport(specifier: string, importerAbs: string, lang: Lang): string | undefined {
  return lang === "ts" ? resolveTs(specifier, importerAbs) : resolvePy(specifier, importerAbs);
}

/**
 * TypeScript/ESM resolution. Only relative specifiers (`./`, `../`) can be
 * local; a bare specifier is always a package. Tries the usual extension and
 * index-file candidates. `tsconfig` path mapping is out of scope (v1).
 */
function resolveTs(specifier: string, importerAbs: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined; // bare specifier → third-party package
  const base = resolvePath(dirname(importerAbs), specifier);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, resolvePath(base, "index.ts")];
  return candidates.find((c) => existsSync(c));
}

/**
 * Python resolution (v1): map the dotted specifier to a path relative to the
 * importing file's directory — `from util import x` → `util.py`, `from a.b
 * import x` → `a/b.py` (or its package `__init__.py`). A package-relative
 * specifier carries leading dots: one dot is the importer's own package
 * directory, each extra dot climbs one parent — `from .auth import x` →
 * `auth.py` beside the importer, `from ..models import y` → `models.py` one
 * directory up. This covers flat layouts and a package lifted from its own root;
 * resolving against an arbitrary `sys.path` is out of scope.
 */
function resolvePy(specifier: string, importerAbs: string): string | undefined {
  const [, dots = "", rest = ""] = specifier.match(/^(\.*)(.*)$/)!;
  // `level` leading dots: level 1 stays in the importer's package dir, so only
  // the dots beyond the first climb a parent. The remaining dotted name (if any)
  // then descends as path segments.
  const climb = dots.length > 0 ? Array(dots.length - 1).fill("..") : [];
  const parts = rest ? rest.split(".") : [];
  const base = resolvePath(dirname(importerAbs), ...climb, ...parts);
  const candidates = [`${base}.py`, resolvePath(base, "__init__.py")];
  return candidates.find((c) => existsSync(c));
}
