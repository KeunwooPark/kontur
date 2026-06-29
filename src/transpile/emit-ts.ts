/** Render the neutral AST as TypeScript. */
import type { Op } from "../ir/schema.js";
import type { Expr, Fn, Program, Stmt } from "./ast.js";
import { camel } from "./naming.js";

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
    case "member": return `${camel(e.name)}.${e.member}`;
    case "bin": return `(${expr(e.a)} ${BIN[e.op]} ${expr(e.b)})`;
    case "un": return `(!${expr(e.x)})`;
    case "call": return `${camel(e.name)}(${e.args.map(expr).join(", ")})`;
  }
}

function stmt(s: Stmt, indent: string): string[] {
  switch (s.t) {
    case "let":
      return [`${indent}const ${camel(s.name)} = ${expr(s.expr)};`];
    case "expr":
      return [`${indent}${expr(s.expr)};`];
    case "print":
      return [`${indent}console.log(${expr(s.arg)});`];
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
  }
}

function fn(f: Fn): string {
  const params = f.params.map((p) => `${camel(p.name)}: ${tsType(p.type)}`).join(", ");
  const ret =
    f.returns.length === 0 ? "void"
    : f.returns.length === 1 ? tsType(f.returns[0]!.type)
    : `{ ${f.returns.map((r) => `${r.name}: ${tsType(r.type)}`).join("; ")} }`;
  const lines = [`export function ${camel(f.name)}(${params}): ${ret} {`];
  for (const s of f.body) lines.push(...stmt(s, "  "));
  lines.push("}");
  return lines.join("\n");
}

export function emitTypeScript(program: Program): string {
  return program.functions.map(fn).join("\n\n") + "\n";
}
