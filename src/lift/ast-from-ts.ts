/**
 * Parse a TypeScript source string into the neutral AST (ast.ts) using the
 * TypeScript compiler API. Handles the subset our emitter produces.
 */
import * as ts from "typescript";
import type { Expr, Fn, Param, Program, Stmt } from "../transpile/ast.js";
import type { Op } from "../ir/schema.js";

export function parseTypeScript(source: string): Program {
  const sf = ts.createSourceFile("input.ts", source, ts.ScriptTarget.Latest, /*setParentNodes*/ true);
  const functions: Fn[] = [];
  sf.forEachChild((node) => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) functions.push(liftFn(node, sf));
  });
  return { functions };
}

function mapType(t: ts.TypeNode | undefined): string {
  if (!t) return "any";
  switch (t.kind) {
    case ts.SyntaxKind.NumberKeyword: return "int";
    case ts.SyntaxKind.StringKeyword: return "string";
    case ts.SyntaxKind.BooleanKeyword: return "bool";
    case ts.SyntaxKind.VoidKeyword: return "void";
    default: return t.getText();
  }
}

function liftFn(node: ts.FunctionDeclaration, sf: ts.SourceFile): Fn {
  const params: Param[] = node.parameters.map((p) => ({
    name: (p.name as ts.Identifier).text,
    type: mapType(p.type),
  }));
  const returns =
    !node.type || node.type.kind === ts.SyntaxKind.VoidKeyword
      ? []
      : [{ name: "result", type: mapType(node.type) }];
  const body = node.body!.statements.map((s) => liftStmt(s, sf));
  return { name: node.name!.text, params, returns, body };
}

function block(stmt: ts.Statement, sf: ts.SourceFile): Stmt[] {
  return ts.isBlock(stmt) ? stmt.statements.map((s) => liftStmt(s, sf)) : [liftStmt(stmt, sf)];
}

function elseBlock(stmt: ts.Statement | undefined, sf: ts.SourceFile): Stmt[] {
  if (!stmt) return [];
  // `else if` is an IfStatement; wrap so it becomes a nested branch.
  return ts.isBlock(stmt) ? stmt.statements.map((s) => liftStmt(s, sf)) : [liftStmt(stmt, sf)];
}

function liftStmt(s: ts.Statement, sf: ts.SourceFile): Stmt {
  if (ts.isVariableStatement(s)) {
    const decl = s.declarationList.declarations[0]!;
    return { t: "let", name: (decl.name as ts.Identifier).text, expr: liftExpr(decl.initializer!, sf) };
  }
  if (ts.isReturnStatement(s)) {
    return { t: "return", expr: liftExpr(s.expression!, sf) };
  }
  if (ts.isIfStatement(s)) {
    return {
      t: "if",
      cond: liftExpr(s.expression, sf),
      then: block(s.thenStatement, sf),
      else: elseBlock(s.elseStatement, sf),
    };
  }
  if (ts.isForStatement(s)) {
    const decl = (s.initializer as ts.VariableDeclarationList).declarations[0]!;
    const cond = s.condition as ts.BinaryExpression;
    return {
      t: "for",
      varName: (decl.name as ts.Identifier).text,
      from: liftExpr(decl.initializer!, sf),
      to: liftExpr(cond.right, sf),
      body: block(s.statement, sf),
    };
  }
  if (ts.isExpressionStatement(s) && ts.isCallExpression(s.expression)) {
    const call = s.expression;
    if (
      ts.isPropertyAccessExpression(call.expression) &&
      call.expression.expression.getText(sf) === "console" &&
      call.expression.name.text === "log"
    ) {
      return { t: "print", arg: liftExpr(call.arguments[0]!, sf) };
    }
    return { t: "expr", expr: liftExpr(call, sf) };
  }
  throw new Error(`lift(ts): unsupported statement "${ts.SyntaxKind[s.kind]}"`);
}

const BIN_OP: Partial<Record<ts.SyntaxKind, Op>> = {
  [ts.SyntaxKind.EqualsEqualsEqualsToken]: "eq",
  [ts.SyntaxKind.EqualsEqualsToken]: "eq",
  [ts.SyntaxKind.ExclamationEqualsEqualsToken]: "ne",
  [ts.SyntaxKind.ExclamationEqualsToken]: "ne",
  [ts.SyntaxKind.LessThanToken]: "lt",
  [ts.SyntaxKind.LessThanEqualsToken]: "le",
  [ts.SyntaxKind.GreaterThanToken]: "gt",
  [ts.SyntaxKind.GreaterThanEqualsToken]: "ge",
  [ts.SyntaxKind.PercentToken]: "mod",
  [ts.SyntaxKind.PlusToken]: "add",
  [ts.SyntaxKind.MinusToken]: "sub",
  [ts.SyntaxKind.AsteriskToken]: "mul",
  [ts.SyntaxKind.SlashToken]: "div",
  [ts.SyntaxKind.AmpersandAmpersandToken]: "and",
  [ts.SyntaxKind.BarBarToken]: "or",
};

function liftExpr(e: ts.Expression, sf: ts.SourceFile): Expr {
  if (ts.isParenthesizedExpression(e)) return liftExpr(e.expression, sf);
  if (ts.isNumericLiteral(e)) return { t: "lit", value: Number(e.text) };
  if (ts.isStringLiteral(e)) return { t: "lit", value: e.text };
  if (e.kind === ts.SyntaxKind.TrueKeyword) return { t: "lit", value: true };
  if (e.kind === ts.SyntaxKind.FalseKeyword) return { t: "lit", value: false };
  if (e.kind === ts.SyntaxKind.NullKeyword) return { t: "lit", value: null };
  if (ts.isIdentifier(e)) return { t: "var", name: e.text };
  if (ts.isPropertyAccessExpression(e)) {
    return { t: "member", name: (e.expression as ts.Identifier).text, member: e.name.text };
  }
  if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) {
    return { t: "un", op: "not", x: liftExpr(e.operand, sf) };
  }
  if (ts.isBinaryExpression(e)) {
    const op = BIN_OP[e.operatorToken.kind];
    if (!op) throw new Error(`lift(ts): unsupported operator "${ts.SyntaxKind[e.operatorToken.kind]}"`);
    return { t: "bin", op, a: liftExpr(e.left, sf), b: liftExpr(e.right, sf) };
  }
  if (ts.isCallExpression(e)) {
    return { t: "call", name: e.expression.getText(sf), args: e.arguments.map((a) => liftExpr(a, sf)) };
  }
  throw new Error(`lift(ts): unsupported expression "${ts.SyntaxKind[e.kind]}"`);
}
