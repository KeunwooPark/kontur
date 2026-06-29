/** Render the neutral AST as TypeScript. */
import type { Op } from "../ir/schema.js";
import type { Class, Expr, Fn, Program, Stmt } from "./ast.js";
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
    case "member": return `${camel(e.name)}.${e.member}`;
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
    case "call": return `${camel(e.name)}(${e.args.map(expr).join(", ")})`;
  }
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
      return [`${indent}throw new Error(${expr(s.arg)});`];
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

function returnType(f: Fn): string {
  return f.returns.length === 0 ? "void"
    : f.returns.length === 1 ? tsType(f.returns[0]!.type)
    : `{ ${f.returns.map((r) => `${r.name}: ${tsType(r.type)}`).join("; ")} }`;
}

function fn(f: Fn, indent = ""): string {
  const params = f.params.map((p) => `${camel(p.name)}: ${tsType(p.type)}`).join(", ");
  // A method drops the `export function` preamble; the class owns it.
  const head = f.isMethod
    ? `${indent}${camel(f.name)}(${params}): ${returnType(f)} {`
    : `${indent}export function ${camel(f.name)}(${params}): ${returnType(f)} {`;
  const lines = [head];
  for (const s of f.body) lines.push(...stmt(s, indent + "  "));
  lines.push(`${indent}}`);
  return lines.join("\n");
}

function cls(c: Class): string {
  const lines = [`export class ${pascal(c.name)} {`];
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
  return chunks.join("\n\n") + "\n";
}
