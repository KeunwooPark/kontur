/** Render the neutral AST as Python 3. */
import type { Op } from "../ir/schema.js";
import type { Class, Expr, Fn, Import, Param, Program, Stmt } from "./ast.js";
import { pascal, snake } from "./naming.js";

const BIN: Partial<Record<Op, string>> = {
  add: "+", sub: "-", mul: "*", div: "/", mod: "%",
  eq: "==", ne: "!=", lt: "<", le: "<=", gt: ">", ge: ">=",
  is: "is", isnot: "is not", in: "in", notin: "not in",
  and: "and", or: "or", concat: "+",
};

// Prefix unary operators. `not` needs a trailing space (`not x`); the arithmetic
// ones bind tight (`-x`, `+x`, `~x`).
const UN: Partial<Record<Op, string>> = {
  not: "not ", neg: "-", pos: "+", bitnot: "~",
};

function pyType(irType: string): string {
  switch (irType) {
    case "int": return "int";
    case "float": return "float";
    case "string": return "str";
    case "bool": return "bool";
    default: return irType;
  }
}

function lit(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "True" : "False";
  if (value === null) return "None";
  return String(value);
}

function expr(e: Expr): string {
  switch (e.t) {
    case "lit": return lit(e.value);
    case "var": return snake(e.name);
    case "self": return "self";
    case "member": return `${snake(e.name)}["${e.member}"]`;
    // A general attribute read keeps the attribute name verbatim (external API
    // surface, like a package member), recursing into the receiver.
    case "attr": return `${expr(e.obj)}.${e.name}`;
    case "stateGet": return `self.${snake(e.attr)}`;
    case "bin": return `(${expr(e.a)} ${BIN[e.op]} ${expr(e.b)})`;
    case "un": return `(${UN[e.op]}${expr(e.x)})`;
    case "cond": return `(${expr(e.then)} if ${expr(e.cond)} else ${expr(e.else)})`;
    case "array": return `[${e.elems.map(expr).join(", ")}]`;
    case "index": return `${expr(e.obj)}[${expr(e.key)}]`;
    // A slice keeps each present bound around the `:`; an absent bound is an open end.
    case "slice": return `${expr(e.obj)}[${e.start ? expr(e.start) : ""}:${e.stop ? expr(e.stop) : ""}]`;
    case "collection": {
      if (e.form === "dict") {
        const entries = e.entries ?? [];
        return `{${entries.map((en) => `${expr(en.key)}: ${expr(en.value)}`).join(", ")}}`;
      }
      const items = (e.elems ?? []).map(expr);
      // Empty set must be `set()` — `{}` is an empty dict. A single-element tuple
      // needs the trailing comma to stay a tuple rather than a parenthesised value.
      if (e.form === "set") return items.length === 0 ? "set()" : `{${items.join(", ")}}`;
      if (items.length === 1) return `(${items[0]},)`;
      return `(${items.join(", ")})`;
    }
    case "comprehension": {
      // Inclusive range → range(from, to + 1), the inverse the lifter expects.
      const v = snake(e.varName);
      return `[${expr(e.elem)} for ${v} in range(${expr(e.from)}, ${expr(e.to)} + 1)]`;
    }
    case "itercomp": {
      const v = snake(e.varName);
      const head = `for ${v} in ${expr(e.iter)}${e.cond ? ` if ${expr(e.cond)}` : ""}`;
      if (e.form === "dict") return `{${expr(e.key!)}: ${expr(e.value!)} ${head}}`;
      const body = expr(e.elem!);
      if (e.form === "set") return `{${body} ${head}}`;
      if (e.form === "generator") return `(${body} ${head})`;
      return `[${body} ${head}]`;
    }
    // A method call renders `recv.method(args)` with the method name verbatim; a
    // package call keeps its library API name verbatim; a local stub is cased.
    case "call": {
      const args = e.args.map(expr).join(", ");
      if (e.recv) return `${expr(e.recv)}.${e.name}(${args})`;
      return `${e.external ? e.name : snake(e.name)}(${args})`;
    }
  }
}

/** Render one import statement. Named bindings → `from m import …`; namespace
 *  bindings → `import m [as x]`. A single source import never mixes the two. */
function importLine(imp: Import): string {
  if (imp.bindings.length === 0) return `import ${imp.source}`;
  const lines: string[] = [];
  const named = imp.bindings.filter((b) => b.kind === "named");
  if (named.length > 0) {
    const items = named.map((b) => (b.imported === b.local ? b.imported : `${b.imported} as ${b.local}`));
    lines.push(`from ${imp.source} import ${items.join(", ")}`);
  }
  for (const b of imp.bindings) {
    // `default` has no Python form; emit it as an aliased module import (best effort).
    if (b.kind === "namespace" || b.kind === "default") {
      lines.push(b.local === imp.source ? `import ${imp.source}` : `import ${imp.source} as ${b.local}`);
    }
  }
  return lines.join("\n");
}

function stmt(s: Stmt, indent: string): string[] {
  switch (s.t) {
    case "let":
      return [`${indent}${snake(s.name)} = ${expr(s.expr)}`];
    case "assign":
      return [`${indent}${snake(s.name)} = ${expr(s.expr)}`];
    case "expr":
      return [`${indent}${expr(s.expr)}`];
    case "print":
      return [`${indent}print(${expr(s.arg)})`];
    case "stateSet":
      return [`${indent}self.${snake(s.attr)} = ${expr(s.value)}`];
    case "throw":
      // Absent errorType ⇒ the catch-all `Exception`, mirroring how the `try` side
      // emits `except Exception`; a named type emits that constructor
      // (`raise TypeError(...)`).
      return [`${indent}raise ${s.errorType ?? "Exception"}(${expr(s.arg)})`];
    case "rethrow":
      // Re-raise an existing value unchanged: `raise e` (not wrapped).
      return [`${indent}raise ${expr(s.value)}`];
    case "return":
      return [`${indent}return ${expr(s.expr)}`];
    case "returnObject":
      return [`${indent}return { ${s.fields.map((f) => `"${f.name}": ${expr(f.expr)}`).join(", ")} }`];
    case "if": {
      const out = [`${indent}if ${expr(s.cond)}:`];
      for (const t of s.then) out.push(...stmt(t, indent + "    "));
      if (s.else.length > 0) {
        out.push(`${indent}else:`);
        for (const e of s.else) out.push(...stmt(e, indent + "    "));
      }
      return out;
    }
    case "for": {
      const v = snake(s.varName);
      // Inclusive count loop → range(from, to + 1).
      const out = [`${indent}for ${v} in range(${expr(s.from)}, ${expr(s.to)} + 1):`];
      for (const b of s.body) out.push(...stmt(b, indent + "    "));
      return out;
    }
    case "while": {
      const out = [`${indent}while ${expr(s.cond)}:`];
      for (const b of s.body) out.push(...stmt(b, indent + "    "));
      return out;
    }
    case "foreach": {
      const out = [`${indent}for ${snake(s.varName)} in ${expr(s.iter)}:`];
      for (const b of s.body) out.push(...stmt(b, indent + "    "));
      return out;
    }
    case "try": {
      const out = [`${indent}try:`];
      for (const b of s.body) out.push(...stmt(b, indent + "    "));
      // Python needs a type before `as`; the IR catch is catch-all → `Exception`.
      out.push(s.catchParam ? `${indent}except Exception as ${snake(s.catchParam)}:` : `${indent}except:`);
      for (const h of s.handler) out.push(...stmt(h, indent + "    "));
      return out;
    }
  }
}

/**
 * A Python string literal that reparses to EXACTLY `s`, so a captured docstring
 * round-trips. A plain one-liner uses the idiomatic triple-quoted form; anything
 * with a newline, backslash, or quote falls back to a JSON-style escaped literal
 * (which Python parses identically), so fidelity never hinges on the content.
 */
function pyDocLiteral(s: string): string {
  if (s.length > 0 && !/[\n\r\\"]/.test(s)) return `"""${s}"""`;
  return JSON.stringify(s);
}

/** One parameter, with its annotation (omitted for "any"), `*`/`**` prefix, and
 *  default. Python pairs an annotated default with spaces (`x: int = 1`) and a
 *  bare one without (`x=1`); the parser ignores the difference, so either re-lifts. */
function pyParam(p: Param): string {
  const anno = p.type === "any" ? "" : `: ${pyType(p.type)}`;
  if (p.variadic === "args") return `*${snake(p.name)}${anno}`;
  if (p.variadic === "kwargs") return `**${snake(p.name)}${anno}`;
  const dflt = p.default === undefined ? "" : anno ? ` = ${expr(p.default)}` : `=${expr(p.default)}`;
  return `${snake(p.name)}${anno}${dflt}`;
}

/** Render the parameter list, inserting a bare `*` before keyword-only params
 *  when no `*args` already separates them. A method takes an implicit `self`. */
function pyParams(f: Fn): string {
  const parts: string[] = f.isMethod ? ["self"] : [];
  let starEmitted = false;
  for (const p of f.params) {
    if (p.variadic === "args") starEmitted = true;
    else if (p.keywordOnly && p.variadic === undefined && !starEmitted) {
      parts.push("*");
      starEmitted = true;
    }
    parts.push(pyParam(p));
  }
  return parts.join(", ");
}

function fn(f: Fn, indent = ""): string {
  const params = pyParams(f);
  const ret =
    f.returns.length === 0 ? "None"
    : f.returns.length === 1 ? pyType(f.returns[0]!.type)
    : "dict";
  // Decorators sit on their own `@<text>` lines above the def, outermost first.
  const lines = (f.decorators ?? []).map((d) => `${indent}@${d}`);
  lines.push(`${indent}def ${snake(f.name)}(${params}) -> ${ret}:`);
  const body: string[] = [];
  // The docstring is the first body statement (PEP 257). A doc-only body is a
  // complete Python body, so it needs no `pass` filler.
  if (f.doc !== undefined) body.push(`${indent}    ${pyDocLiteral(f.doc)}`);
  for (const s of f.body) body.push(...stmt(s, indent + "    "));
  if (body.length === 0) body.push(`${indent}    pass`);
  lines.push(...body);
  return lines.join("\n");
}

function cls(c: Class): string {
  // Bases are type identifiers, emitted verbatim (not re-cased) — Python allows
  // several, joined as positional bases: `class C(A, B):`.
  const bases = c.bases && c.bases.length ? `(${c.bases.join(", ")})` : "";
  const lines = (c.decorators ?? []).map((d) => `@${d}`);
  lines.push(`class ${pascal(c.name)}${bases}:`);
  if (c.doc !== undefined) lines.push(`    ${pyDocLiteral(c.doc)}`);
  for (const field of c.fields) lines.push(`    ${snake(field.name)}: ${pyType(field.type)}`);
  for (const m of c.methods) {
    lines.push("");
    lines.push(fn(m, "    "));
  }
  // A docstring is itself a complete body, so an otherwise-empty class needs no `pass`.
  if (c.doc === undefined && c.fields.length === 0 && c.methods.length === 0) lines.push("    pass");
  return lines.join("\n");
}

export function emitPython(program: Program): string {
  const chunks = [...program.classes.map(cls), ...program.functions.map((f) => fn(f))];
  const body = chunks.join("\n\n\n") + "\n";
  const imports = (program.imports ?? []).map(importLine);
  return imports.length > 0 ? imports.join("\n") + "\n\n\n" + body : body;
}
