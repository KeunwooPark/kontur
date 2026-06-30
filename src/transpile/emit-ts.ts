/** Render the neutral AST as TypeScript. */
import type { Op } from "../ir/schema.js";
import type { Class, Expr, Fn, Import, Param, Program, Stmt } from "./ast.js";
import { camel, pascal } from "./naming.js";

const BIN: Partial<Record<Op, string>> = {
  add: "+", sub: "-", mul: "*", div: "/", mod: "%",
  eq: "===", ne: "!==", lt: "<", le: "<=", gt: ">", ge: ">=",
  and: "&&", or: "||", concat: "+",
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
    case "bin": return `(${expr(e.a)} ${BIN[e.op]} ${expr(e.b)})`;
    case "un": return `(!${expr(e.x)})`;
    case "cond": return `(${expr(e.cond)} ? ${expr(e.then)} : ${expr(e.else)})`;
    case "array": return `[${e.elems.map(expr).join(", ")}]`;
    case "comprehension": {
      // TS has no comprehension syntax; emit a range-map. The bound variable runs
      // 0-based, matching the example-level `from === 0` comprehensions we lift.
      const v = camel(e.varName);
      return `Array.from({ length: ${expr(e.to)} - ${expr(e.from)} + 1 }, (_, ${v}) => ${expr(e.elem)})`;
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
    case "throw":
      // Absent errorType ⇒ the catch-all `Error`; a named type emits that
      // constructor (`throw new TypeError(...)`).
      return [`${indent}throw new ${s.errorType ?? "Error"}(${expr(s.arg)});`];
    case "rethrow":
      return [`${indent}throw ${expr(s.value)};`];
    case "return":
      return [`${indent}return ${expr(s.expr)};`];
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
      const out = [`${indent}for (const ${camel(s.varName)} of ${expr(s.iter)}) {`];
      for (const b of s.body) out.push(...stmt(b, indent + "  "));
      out.push(`${indent}}`);
      return out;
    }
    case "try": {
      const out = [`${indent}try {`];
      for (const b of s.body) out.push(...stmt(b, indent + "  "));
      out.push(s.catchParam ? `${indent}} catch (${camel(s.catchParam)}) {` : `${indent}} catch {`);
      for (const h of s.handler) out.push(...stmt(h, indent + "  "));
      out.push(`${indent}}`);
      return out;
    }
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
