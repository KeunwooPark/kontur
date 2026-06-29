/** Render the neutral AST as Python 3. */
import type { Op } from "../ir/schema.js";
import type { Expr, Fn, Program, Stmt } from "./ast.js";
import { snake } from "./naming.js";

const BIN: Partial<Record<Op, string>> = {
  add: "+", sub: "-", mul: "*", div: "/", mod: "%",
  eq: "==", ne: "!=", lt: "<", le: "<=", gt: ">", ge: ">=",
  and: "and", or: "or", concat: "+",
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
    case "member": return `${snake(e.name)}["${e.member}"]`;
    case "bin": return `(${expr(e.a)} ${BIN[e.op]} ${expr(e.b)})`;
    case "un": return `(not ${expr(e.x)})`;
    case "call": return `${snake(e.name)}(${e.args.map(expr).join(", ")})`;
  }
}

function stmt(s: Stmt, indent: string): string[] {
  switch (s.t) {
    case "let":
      return [`${indent}${snake(s.name)} = ${expr(s.expr)}`];
    case "expr":
      return [`${indent}${expr(s.expr)}`];
    case "print":
      return [`${indent}print(${expr(s.arg)})`];
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
  }
}

function fn(f: Fn): string {
  const params = f.params.map((p) => `${snake(p.name)}: ${pyType(p.type)}`).join(", ");
  const ret =
    f.returns.length === 0 ? "None"
    : f.returns.length === 1 ? pyType(f.returns[0]!.type)
    : "dict";
  const lines = [`def ${snake(f.name)}(${params}) -> ${ret}:`];
  const body: string[] = [];
  for (const s of f.body) body.push(...stmt(s, "    "));
  if (body.length === 0) body.push("    pass");
  lines.push(...body);
  return lines.join("\n");
}

export function emitPython(program: Program): string {
  return program.functions.map(fn).join("\n\n\n") + "\n";
}
