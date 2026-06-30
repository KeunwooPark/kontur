/** Render the neutral AST as TypeScript. */
import type { Op } from "../ir/schema.js";
import type { Class, Expr, Fn, Import, Param, Program, Stmt } from "./ast.js";
import { camel, pascal } from "./naming.js";

const BIN: Partial<Record<Op, string>> = {
  add: "+", sub: "-", mul: "*", div: "/", mod: "%",
  // `is`/`is not` (identity) have no TS form; cross-compile to the closest infix
  // `===`/`!==`. Membership (`in`/`not in`) is handled separately in `expr` since
  // its closest TS form (`.includes()`) is not infix.
  eq: "===", ne: "!==", lt: "<", le: "<=", gt: ">", ge: ">=",
  is: "===", isnot: "!==",
  and: "&&", or: "||", concat: "+",
};

// Prefix unary operators: `!x`, `-x`, `+x`, `~x`.
const UN: Partial<Record<Op, string>> = {
  not: "!", neg: "-", pos: "+", bitnot: "~",
};

function tsType(irType: string): string {
  switch (irType) {
    case "int":
    case "float":
      return "number";
    case "string":
      return "string";
    case "bool":
      return "boolean";
    default:
      return irType; // a domain type (e.g. User) — assumed declared elsewhere
  }
}

function lit(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "null";
  return String(value);
}

function expr(e: Expr): string {
  switch (e.t) {
    case "lit": return lit(e.value);
    case "var": return camel(e.name);
    case "self": return "this";
    case "member": return `${camel(e.name)}.${e.member}`;
    // A general attribute read keeps the attribute name verbatim (external API
    // surface), recursing into the receiver.
    case "attr": return `${expr(e.obj)}.${e.name}`;
    case "stateGet": return `this.${camel(e.attr)}`;
    // Membership cross-compiles one-way to `.includes()` (best-effort: correct for
    // arrays/strings, the common case); `not in` negates it. Other binary ops are
    // plain infix via the BIN map.
    case "bin": {
      if (e.op === "in") return `(${expr(e.b)}.includes(${expr(e.a)}))`;
      if (e.op === "notin") return `(!${expr(e.b)}.includes(${expr(e.a)}))`;
      return `(${expr(e.a)} ${BIN[e.op]} ${expr(e.b)})`;
    }
    case "un": return `(${UN[e.op]}${expr(e.x)})`;
    case "cond": return `(${expr(e.cond)} ? ${expr(e.then)} : ${expr(e.else)})`;
    case "array": return `[${e.elems.map(expr).join(", ")}]`;
    case "index": return `${expr(e.obj)}[${expr(e.key)}]`;
    // TS has no slice syntax; cross-compile one-way to `.slice(start, stop)` (a
    // Python-only construct — the TS lifter never produces it). An absent start
    // defaults to 0; an absent stop omits the second arg (slice to the end).
    case "slice": return `${expr(e.obj)}.slice(${e.start ? expr(e.start) : "0"}${e.stop ? `, ${expr(e.stop)}` : ""})`;
    case "collection": {
      // One-way cross-compile (these forms re-lift from Python, not TS): a tuple
      // becomes a plain array (TS has no distinct runtime tuple), a set a `new
      // Set([…])`, a dict a `new Map([[k, v], …])` (faithful for arbitrary keys).
      if (e.form === "dict") {
        const entries = e.entries ?? [];
        return `new Map([${entries.map((en) => `[${expr(en.key)}, ${expr(en.value)}]`).join(", ")}])`;
      }
      const items = (e.elems ?? []).map(expr).join(", ");
      return e.form === "set" ? `new Set([${items}])` : `[${items}]`;
    }
    case "comprehension": {
      // TS has no comprehension syntax; emit a range-map. The bound variable runs
      // 0-based, matching the example-level `from === 0` comprehensions we lift.
      const v = camel(e.varName);
      return `Array.from({ length: ${expr(e.to)} - ${expr(e.from)} + 1 }, (_, ${v}) => ${expr(e.elem)})`;
    }
    case "itercomp": {
      // TS has no comprehension syntax; cross-compile to a filter/map chain (a
      // one-way emit, like the range comprehension above). `if` becomes `.filter`,
      // the element a `.map`; a dict builds entries via `Object.fromEntries`, a set
      // wraps the mapped array, a generator collapses to the same eager array map.
      const v = e.varNames ? `[${e.varNames.map(camel).join(", ")}]` : camel(e.varName!);
      const src = e.cond ? `${expr(e.iter)}.filter((${v}) => ${expr(e.cond)})` : expr(e.iter);
      if (e.form === "dict") return `Object.fromEntries(${src}.map((${v}) => [${expr(e.key!)}, ${expr(e.value!)}]))`;
      const mapped = `${src}.map((${v}) => ${expr(e.elem!)})`;
      return e.form === "set" ? `new Set(${mapped})` : mapped;
    }
    // A method call renders `recv.method(args)` with the method name verbatim; a
    // package call keeps its library API name verbatim (no re-casing, dotted
    // member access preserved); a local helper/stub is cased like any identifier.
    case "call": {
      const args = e.args.map(expr).join(", ");
      if (e.recv) return `${expr(e.recv)}.${e.name}(${args})`;
      return `${e.external ? e.name : camel(e.name)}(${args})`;
    }
  }
}

/** Render one import statement. Bindings come from a single source import, so the
 *  default / namespace / named clauses present are a valid TS combination. */
function importLine(imp: Import): string {
  if (imp.bindings.length === 0) return `import "${imp.source}";`;
  const clauses: string[] = [];
  const def = imp.bindings.find((b) => b.kind === "default");
  const ns = imp.bindings.find((b) => b.kind === "namespace");
  const named = imp.bindings.filter((b) => b.kind === "named");
  if (def) clauses.push(def.local);
  if (ns) clauses.push(`* as ${ns.local}`);
  if (named.length > 0) {
    const items = named.map((b) => (b.imported === b.local ? b.local : `${b.imported} as ${b.local}`));
    clauses.push(`{ ${items.join(", ")} }`);
  }
  return `import ${clauses.join(", ")} from "${imp.source}";`;
}

function stmt(s: Stmt, indent: string): string[] {
  switch (s.t) {
    case "let":
      return [`${indent}const ${camel(s.name)} = ${expr(s.expr)};`];
    case "assign":
      return [`${indent}${camel(s.name)} = ${expr(s.expr)};`];
    case "expr":
      return [`${indent}${expr(s.expr)};`];
    case "print":
      return [`${indent}console.log(${expr(s.arg)});`];
    case "stateSet":
      return [`${indent}this.${camel(s.attr)} = ${expr(s.value)};`];
    case "attrSet":
      return [`${indent}${expr(s.obj)}.${s.attr} = ${expr(s.value)};`];
    case "indexSet":
      return [`${indent}${expr(s.obj)}[${expr(s.key)}] = ${expr(s.value)};`];
    case "destructure":
      return [`${indent}const [${s.names.map(camel).join(", ")}] = ${expr(s.value)};`];
    case "throw":
      // Absent errorType ⇒ the catch-all `Error`; a named type emits that
      // constructor (`throw new TypeError(...)`).
      return [`${indent}throw new ${s.errorType ?? "Error"}(${expr(s.arg)});`];
    case "rethrow":
      return [`${indent}throw ${expr(s.value)};`];
    case "return":
      return [`${indent}return${s.expr ? ` ${expr(s.expr)}` : ""};`];
    case "returnObject":
      return [`${indent}return { ${s.fields.map((f) => `${f.name}: ${expr(f.expr)}`).join(", ")} };`];
    case "if": {
      const out = [`${indent}if (${expr(s.cond)}) {`];
      for (const t of s.then) out.push(...stmt(t, indent + "  "));
      if (s.else.length > 0) {
        out.push(`${indent}} else {`);
        for (const e of s.else) out.push(...stmt(e, indent + "  "));
      }
      out.push(`${indent}}`);
      return out;
    }
    case "for": {
      const v = camel(s.varName);
      const out = [`${indent}for (let ${v} = ${expr(s.from)}; ${v} <= ${expr(s.to)}; ${v}++) {`];
      for (const b of s.body) out.push(...stmt(b, indent + "  "));
      out.push(`${indent}}`);
      return out;
    }
    case "while": {
      const out = [`${indent}while (${expr(s.cond)}) {`];
      for (const b of s.body) out.push(...stmt(b, indent + "  "));
      out.push(`${indent}}`);
      return out;
    }
    case "foreach": {
      const target = s.names ? `[${s.names.map(camel).join(", ")}]` : camel(s.varName!);
      const out = [`${indent}for (const ${target} of ${expr(s.iter)}) {`];
      for (const b of s.body) out.push(...stmt(b, indent + "  "));
      out.push(`${indent}}`);
      return out;
    }
    case "try": {
      const out = [`${indent}try {`];
      for (const b of s.body) out.push(...stmt(b, indent + "  "));
      // A typed handler has no native TS form; cross-compile ONE-WAY to a catch
      // that re-throws anything not matching the type(s) via `instanceof`. The
      // `else` block (no native TS form) is emitted inside the catch-free path.
      if (s.errorTypes && s.errorTypes.length) {
        const e = s.catchParam ? camel(s.catchParam) : "_e";
        out.push(`${indent}} catch (${e}) {`);
        out.push(`${indent}  if (${s.errorTypes.map((t) => `!(${e} instanceof ${t})`).join(" && ")}) throw ${e};`);
      } else {
        out.push(s.catchParam ? `${indent}} catch (${camel(s.catchParam)}) {` : `${indent}} catch {`);
      }
      for (const h of s.handler) out.push(...stmt(h, indent + "  "));
      if (s.finalbody && s.finalbody.length) {
        out.push(`${indent}} finally {`);
        for (const f of s.finalbody) out.push(...stmt(f, indent + "  "));
      }
      out.push(`${indent}}`);
      // Python's `else` (runs when the body did not raise) has no TS equivalent;
      // emit it after the try as a best-effort one-way approximation.
      if (s.orelse && s.orelse.length) for (const e of s.orelse) out.push(...stmt(e, indent));
      return out;
    }
    case "with": {
      // TS has no Python `with`; cross-compile ONE-WAY to a `using` disposable
      // block (TS 5.2+) — the resource is disposed at the block's close. A no-`as`
      // context still binds a throwaway so the manager's enter/exit runs.
      const r = s.resource ? camel(s.resource) : "_ctx";
      const out = [`${indent}{`, `${indent}  using ${r} = ${expr(s.context)};`];
      for (const b of s.body) out.push(...stmt(b, indent + "  "));
      out.push(`${indent}}`);
      return out;
    }
    case "assert": {
      // No TS `assert` statement; cross-compile ONE-WAY to `console.assert`.
      return [`${indent}console.assert(${expr(s.cond)}${s.message ? `, ${expr(s.message)}` : ""});`];
    }
    case "pass": return []; // a no-op; TS blocks may be empty (`{}`)
    case "break": return [`${indent}break;`];
    case "continue": return [`${indent}continue;`];
  }
}

/**
 * Render a captured doc string as a JSDoc block, one ` * `-margined line each, so
 * the TS lifter recovers the exact text via the compiler's JSDoc parsing (which
 * strips that margin and rejoins with newlines). The neutral-AST counterpart of a
 * Python docstring.
 */
function jsDoc(doc: string, indent: string): string[] {
  return [`${indent}/**`, ...doc.split("\n").map((l) => `${indent} * ${l}`), `${indent} */`];
}

function returnType(f: Fn): string {
  return f.returns.length === 0 ? "void"
    : f.returns.length === 1 ? tsType(f.returns[0]!.type)
    : `{ ${f.returns.map((r) => `${r.name}: ${tsType(r.type)}`).join("; ")} }`;
}

/** One parameter: a `...` rest prefix for a variadic, the annotation (omitted
 *  for "any"), and a default. TS has no keyword-only form, so that marker is not
 *  rendered (a Python-only signature detail). */
function tsParam(p: Param): string {
  const rest = p.variadic !== undefined ? "..." : "";
  const anno = p.type === "any" ? "" : `: ${tsType(p.type)}`;
  const dflt = p.default !== undefined ? ` = ${expr(p.default)}` : "";
  return `${rest}${camel(p.name)}${anno}${dflt}`;
}

function fn(f: Fn, indent = ""): string {
  const params = f.params.map(tsParam).join(", ");
  // A method drops the `export function` preamble; the class owns it.
  const head = f.isMethod
    ? `${indent}${camel(f.name)}(${params}): ${returnType(f)} {`
    : `${indent}export function ${camel(f.name)}(${params}): ${returnType(f)} {`;
  const lines = f.doc !== undefined ? jsDoc(f.doc, indent) : [];
  // Decorators follow the doc block, each on its own `@<text>` line.
  for (const d of f.decorators ?? []) lines.push(`${indent}@${d}`);
  lines.push(head);
  for (const s of f.body) lines.push(...stmt(s, indent + "  "));
  lines.push(`${indent}}`);
  return lines.join("\n");
}

function cls(c: Class): string {
  const lines = c.doc !== undefined ? jsDoc(c.doc, "") : [];
  // TS has single inheritance: emit the bases (verbatim type identifiers) via one
  // `extends`. A class lifted from TS carries at most one base; a Python class with
  // several has no faithful TS form, so they are joined after `extends` as-is.
  const heritage = c.bases && c.bases.length ? ` extends ${c.bases.join(", ")}` : "";
  for (const d of c.decorators ?? []) lines.push(`@${d}`);
  lines.push(`export class ${pascal(c.name)}${heritage} {`);
  for (const f of c.fields) lines.push(`  ${camel(f.name)}: ${tsType(f.type)};`);
  for (const m of c.methods) {
    lines.push("");
    lines.push(fn(m, "  "));
  }
  lines.push("}");
  return lines.join("\n");
}

export function emitTypeScript(program: Program): string {
  const chunks = [...program.classes.map(cls), ...program.functions.map((f) => fn(f))];
  const body = chunks.join("\n\n") + "\n";
  const imports = (program.imports ?? []).map(importLine);
  return imports.length > 0 ? imports.join("\n") + "\n\n" + body : body;
}
