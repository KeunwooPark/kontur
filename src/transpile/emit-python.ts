/** Render the neutral AST as Python 3. */
import type { Op } from "../ir/schema.js";
import type { Class, Expr, Fn, Program, Stmt } from "./ast.js";
import { pascal, snake } from "./naming.js";

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
    case "stateGet": return `self.${snake(e.attr)}`;
    case "bin": return `(${expr(e.a)} ${BIN[e.op]} ${expr(e.b)})`;
    case "un": return `(not ${expr(e.x)})`;
    case "cond": return `(${expr(e.then)} if ${expr(e.cond)} else ${expr(e.else)})`;
    case "array": return `[${e.elems.map(expr).join(", ")}]`;
    case "comprehension": {
      // Inclusive range → range(from, to + 1), the inverse the lifter expects.
      const v = snake(e.varName);
      return `[${expr(e.elem)} for ${v} in range(${expr(e.from)}, ${expr(e.to)} + 1)]`;
    }
    case "call": return `${snake(e.name)}(${e.args.map(expr).join(", ")})`;
  }
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
  }
}

function fn(f: Fn, indent = ""): string {
  const declared = f.params.map((p) => `${snake(p.name)}: ${pyType(p.type)}`);
  // A method takes an implicit leading `self`.
  const params = (f.isMethod ? ["self", ...declared] : declared).join(", ");
  const ret =
    f.returns.length === 0 ? "None"
    : f.returns.length === 1 ? pyType(f.returns[0]!.type)
    : "dict";
  const lines = [`${indent}def ${snake(f.name)}(${params}) -> ${ret}:`];
  const body: string[] = [];
  for (const s of f.body) body.push(...stmt(s, indent + "    "));
  if (body.length === 0) body.push(`${indent}    pass`);
  lines.push(...body);
  return lines.join("\n");
}

function cls(c: Class): string {
  const lines = [`class ${pascal(c.name)}:`];
  for (const field of c.fields) lines.push(`    ${snake(field.name)}: ${pyType(field.type)}`);
  for (const m of c.methods) {
    lines.push("");
    lines.push(fn(m, "    "));
  }
  if (c.fields.length === 0 && c.methods.length === 0) lines.push("    pass");
  return lines.join("\n");
}

export function emitPython(program: Program): string {
  const chunks = [...program.classes.map(cls), ...program.functions.map((f) => fn(f))];
  return chunks.join("\n\n\n") + "\n";
}
