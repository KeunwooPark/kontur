/**
 * Parse a TypeScript source string into the neutral AST (ast.ts) using the
 * TypeScript compiler API. Handles the subset our emitter produces.
 */
import * as ts from "typescript";
import type { Class, DefaultValue, Expr, Field, Fn, Import, ImportBinding, Param, Program, Stmt } from "../transpile/ast.js";
import type { Op } from "../ir/schema.js";

export function parseTypeScript(source: string): Program {
  const sf = ts.createSourceFile("input.ts", source, ts.ScriptTarget.Latest, /*setParentNodes*/ true);
  const functions: Fn[] = [];
  const classes: Class[] = [];
  const imports: Import[] = [];
  sf.forEachChild((node) => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) functions.push(liftFn(node, sf));
    else if (ts.isClassDeclaration(node) && node.name) classes.push(liftClass(node, sf));
    else if (ts.isImportDeclaration(node)) imports.push(liftImport(node));
    // `import x = require(...)` is a distinct, non-ESM form with no IR model.
    else if (ts.isImportEqualsDeclaration(node)) {
      throw new Error(`lift(ts): unsupported "import = require()" (only ES module imports are modelled)`);
    }
    // Other top-level nodes (the EOF token, etc.) are ignored. An `export … from`
    // re-export is an ExportDeclaration, not handled here.
  });
  return { functions, classes, imports };
}

/**
 * Lift an ES module import declaration into the neutral `Import`. Captures the
 * value bindings verbatim (default / namespace / named, with aliases) so the
 * transpiler can reproduce the line. Type-only imports carry no runtime meaning
 * and have no IR model, so they are refused loudly rather than silently dropped.
 */
function liftImport(node: ts.ImportDeclaration): Import {
  const source = (node.moduleSpecifier as ts.StringLiteral).text;
  const clause = node.importClause;
  // Bare side-effect import: `import "x";`.
  if (!clause) return { source, bindings: [] };
  if (clause.isTypeOnly) throw new Error(`lift(ts): unsupported type-only import from "${source}"`);
  const bindings: ImportBinding[] = [];
  if (clause.name) bindings.push({ kind: "default", local: clause.name.text });
  const nb = clause.namedBindings;
  if (nb) {
    if (ts.isNamespaceImport(nb)) {
      bindings.push({ kind: "namespace", local: nb.name.text });
    } else {
      for (const el of nb.elements) {
        if (el.isTypeOnly) throw new Error(`lift(ts): unsupported type-only import binding "${el.name.text}" from "${source}"`);
        bindings.push({ kind: "named", imported: (el.propertyName ?? el.name).text, local: el.name.text });
      }
    }
  }
  return { source, bindings };
}

/**
 * The text of a node's JSDoc block (`/** … *​/`), or undefined if it has none.
 * The compiler API hands back the cleaned comment (the ` * ` margins stripped,
 * lines rejoined with newlines) — the exact inverse of how `emit-ts` renders a
 * `doc`, so it round-trips. Only a plain-text comment is captured; a comment
 * carrying `@tag` links surfaces as a non-string and is left undocumented.
 */
function docOf(node: ts.Node): string | undefined {
  const jsDoc = (node as { jsDoc?: ts.JSDoc[] }).jsDoc;
  if (!jsDoc || jsDoc.length === 0) return undefined;
  const comment = jsDoc[jsDoc.length - 1]!.comment;
  return typeof comment === "string" ? comment : undefined;
}

/**
 * Decorators on a class or member, outermost first, each the decorator
 * expression carried VERBATIM without its leading `@` — the inverse of how
 * `emit-ts` renders `decorators`. Opaque metadata, not analysed (cf. `bases`).
 */
function decoratorsOf(node: ts.HasDecorators, sf: ts.SourceFile): string[] {
  return (ts.getDecorators(node) ?? []).map((d) => d.expression.getText(sf));
}

function liftClass(node: ts.ClassDeclaration, sf: ts.SourceFile): Class {
  const fields: Field[] = [];
  const methods: Fn[] = [];
  // `extends` clauses become bases (verbatim type identifiers). `implements` and
  // type arguments on a base have no IR home, so refuse them loudly rather than
  // drop them silently.
  const bases: string[] = [];
  for (const clause of node.heritageClauses ?? []) {
    if (clause.token === ts.SyntaxKind.ImplementsKeyword) {
      throw new Error("lift(ts): unsupported `implements` clause (not yet in the IR)");
    }
    for (const t of clause.types) {
      if (t.typeArguments) throw new Error("lift(ts): unsupported type arguments on a base class");
      bases.push(t.expression.getText(sf));
    }
  }
  for (const member of node.members) {
    if (ts.isPropertyDeclaration(member) && ts.isIdentifier(member.name)) {
      fields.push({ name: member.name.text, type: mapType(member.type) });
    } else if (ts.isMethodDeclaration(member) && ts.isIdentifier(member.name) && member.body) {
      methods.push(liftCallable(member.name.text, member.parameters, member.type, member.body, sf, true, docOf(member), decoratorsOf(member, sf)));
    } else {
      throw new Error(`lift(ts): unsupported class member "${ts.SyntaxKind[member.kind]}"`);
    }
  }
  const doc = docOf(node);
  const decorators = decoratorsOf(node, sf);
  return { name: node.name!.text, fields, methods, ...(bases.length ? { bases } : {}), ...(decorators.length ? { decorators } : {}), ...(doc !== undefined ? { doc } : {}) };
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
  return liftCallable(node.name!.text, node.parameters, node.type, node.body!, sf, false, docOf(node));
}

/** Shared lowering for a function declaration and a class method. */
function liftCallable(
  name: string,
  parameters: ts.NodeArray<ts.ParameterDeclaration>,
  type: ts.TypeNode | undefined,
  body: ts.Block,
  sf: ts.SourceFile,
  isMethod: boolean,
  doc: string | undefined,
  decorators: string[] = [],
): Fn {
  const params: Param[] = parameters.map((p) => {
    const param: Param = { name: (p.name as ts.Identifier).text, type: mapType(p.type) };
    // A `...rest` param is variadic; TS has one rest kind, modelled as "args".
    if (p.dotDotDotToken) param.variadic = "args";
    if (p.initializer) param.default = liftDefault(p.initializer, sf);
    return param;
  });
  const returns =
    !type || type.kind === ts.SyntaxKind.VoidKeyword
      ? []
      : [{ name: "result", type: mapType(type) }];
  const stmts = body.statements.map((s) => liftStmt(s, sf));
  return { name, params, returns, body: stmts, ...(isMethod ? { isMethod: true } : {}), ...(decorators.length ? { decorators } : {}), ...(doc !== undefined ? { doc } : {}) };
}

/** A parameter default, restricted to the forms the IR carries (a literal or a
 *  bare name); a richer default expression refuses loudly. */
function liftDefault(node: ts.Expression, sf: ts.SourceFile): DefaultValue {
  const e = liftExpr(node, sf);
  if (e.t === "lit") return { t: "lit", value: e.value as string | number | boolean | null };
  if (e.t === "var") return { t: "var", name: e.name };
  throw new Error("lift(ts): unsupported default value (only a literal or a bare name is modelled yet)");
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
  if (ts.isWhileStatement(s)) {
    return { t: "while", cond: liftExpr(s.expression, sf), body: block(s.statement, sf) };
  }
  if (ts.isForOfStatement(s)) {
    // Iterate a collection: `for (const item of iter) { … }`. The IR models this
    // as a `foreach` node — the iterable on data-in, the element bound for the
    // body. Only a single `const`/`let` identifier binding is modelled; a
    // destructuring pattern or `await` is non-trivial and refused, not guessed.
    if (s.awaitModifier) throw new Error(`lift(ts): unsupported "for await ... of"`);
    if (!ts.isVariableDeclarationList(s.initializer) || s.initializer.declarations.length !== 1) {
      throw new Error(`lift(ts): unsupported for-of initializer (expected a single binding)`);
    }
    const decl = s.initializer.declarations[0]!;
    if (!ts.isIdentifier(decl.name)) {
      throw new Error(`lift(ts): unsupported for-of binding (only a single identifier, not a pattern)`);
    }
    return { t: "foreach", varName: decl.name.text, iter: liftExpr(s.expression, sf), body: block(s.statement, sf) };
  }
  if (ts.isThrowStatement(s)) {
    // Two raising shapes are modelled, mirroring the two IR nodes:
    //   `throw new Error(msg)` → `throw`  (construct a fresh error from a message)
    //   `throw e`              → `rethrow` (re-raise an existing value unchanged)
    // Constructing any single-arg error type maps too: the constructor name is
    // carried as the throw node's `errorType` (`Error` stays the catch-all default,
    // so it is left implicit). A thrown literal (`throw "x"`) or any other
    // expression is neither a construction nor a named value, so it is refused.
    const e = s.expression;
    if (
      ts.isNewExpression(e) &&
      ts.isIdentifier(e.expression) &&
      e.arguments?.length === 1
    ) {
      const ctor = e.expression.text;
      return { t: "throw", arg: liftExpr(e.arguments[0]!, sf), ...(ctor === "Error" ? {} : { errorType: ctor }) };
    }
    if (ts.isIdentifier(e)) {
      return { t: "rethrow", value: { t: "var", name: e.text } };
    }
    throw new Error(`lift(ts): unsupported throw (only \`throw new <Error>(message)\` or re-raising a value \`throw e\` is modelled)`);
  }
  if (ts.isTryStatement(s)) {
    // The IR models a single catch-all handler. `finally` is non-local control
    // flow with no IR node; a try without catch is the same shape — refuse both
    // rather than silently drop them.
    if (s.finallyBlock) throw new Error(`lift(ts): unsupported "try/finally" (no IR node for finally)`);
    if (!s.catchClause) throw new Error(`lift(ts): unsupported "try" without a catch clause`);
    const decl = s.catchClause.variableDeclaration;
    const catchParam = decl && ts.isIdentifier(decl.name) ? decl.name.text : undefined;
    return {
      t: "try",
      body: s.tryBlock.statements.map((x) => liftStmt(x, sf)),
      ...(catchParam ? { catchParam } : {}),
      handler: s.catchClause.block.statements.map((x) => liftStmt(x, sf)),
    };
  }
  if (
    ts.isExpressionStatement(s) &&
    ts.isBinaryExpression(s.expression) &&
    s.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isPropertyAccessExpression(s.expression.left) &&
    s.expression.left.expression.kind === ts.SyntaxKind.ThisKeyword
  ) {
    return { t: "stateSet", attr: s.expression.left.name.text, value: liftExpr(s.expression.right, sf) };
  }
  // Reassignment of a plain local/param: `x = …` or augmented `x += …`. Dataflow
  // is single-assignment, so the lifter (to-ir) rebinds the name SSA-style.
  if (
    ts.isExpressionStatement(s) &&
    ts.isBinaryExpression(s.expression) &&
    ts.isIdentifier(s.expression.left)
  ) {
    const be = s.expression;
    const name = be.left.getText(sf);
    if (be.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      return { t: "assign", name, expr: liftExpr(be.right, sf) };
    }
    const aug = AUG_OP[be.operatorToken.kind];
    if (aug) {
      return { t: "assign", name, expr: { t: "bin", op: aug, a: { t: "var", name }, b: liftExpr(be.right, sf) } };
    }
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

/** Augmented-assignment operators (`+=`, `-=`, …) → the underlying binary op. */
const AUG_OP: Partial<Record<ts.SyntaxKind, Op>> = {
  [ts.SyntaxKind.PlusEqualsToken]: "add",
  [ts.SyntaxKind.MinusEqualsToken]: "sub",
  [ts.SyntaxKind.AsteriskEqualsToken]: "mul",
  [ts.SyntaxKind.SlashEqualsToken]: "div",
  [ts.SyntaxKind.PercentEqualsToken]: "mod",
};

/**
 * A template literal lowers to a left-folded `concat` chain over its string
 * parts and interpolations. The IR has no string-interpolation node, but
 * `concat` is exactly the string-join effect it needs — each backend emits it
 * as `+`. Empty fixed parts (a leading `${...}` or adjacent interpolations) are
 * dropped so the chain carries only the pieces that produce text.
 */
function liftTemplate(e: ts.TemplateExpression, sf: ts.SourceFile): Expr {
  const parts: Expr[] = [];
  if (e.head.text !== "") parts.push({ t: "lit", value: e.head.text });
  for (const span of e.templateSpans) {
    parts.push(liftExpr(span.expression, sf));
    if (span.literal.text !== "") parts.push({ t: "lit", value: span.literal.text });
  }
  if (parts.length === 0) return { t: "lit", value: "" };
  return parts.reduce((a, b) => ({ t: "bin", op: "concat", a, b }));
}

function liftExpr(e: ts.Expression, sf: ts.SourceFile): Expr {
  if (ts.isParenthesizedExpression(e)) return liftExpr(e.expression, sf);
  if (ts.isNumericLiteral(e)) return { t: "lit", value: Number(e.text) };
  if (ts.isStringLiteral(e)) return { t: "lit", value: e.text };
  // A template with no interpolation is just a string literal.
  if (ts.isNoSubstitutionTemplateLiteral(e)) return { t: "lit", value: e.text };
  if (ts.isTemplateExpression(e)) return liftTemplate(e, sf);
  if (e.kind === ts.SyntaxKind.TrueKeyword) return { t: "lit", value: true };
  if (e.kind === ts.SyntaxKind.FalseKeyword) return { t: "lit", value: false };
  if (e.kind === ts.SyntaxKind.NullKeyword) return { t: "lit", value: null };
  if (ts.isIdentifier(e)) return { t: "var", name: e.text };
  if (e.kind === ts.SyntaxKind.ThisKeyword) return { t: "self" };
  if (ts.isPropertyAccessExpression(e)) {
    if (e.expression.kind === ts.SyntaxKind.ThisKeyword) {
      return { t: "stateGet", attr: e.name.text };
    }
    // A general attribute read `obj.attr` — the receiver may be any expression.
    // (A multi-output call result accessed as `r.field` also lands here; it
    // round-trips as an attribute read, which is faithful at the source level.)
    return { t: "attr", obj: liftExpr(e.expression, sf), name: e.name.text };
  }
  if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) {
    return { t: "un", op: "not", x: liftExpr(e.operand, sf) };
  }
  if (ts.isBinaryExpression(e)) {
    const op = BIN_OP[e.operatorToken.kind];
    if (!op) throw new Error(`lift(ts): unsupported operator "${ts.SyntaxKind[e.operatorToken.kind]}"`);
    return { t: "bin", op, a: liftExpr(e.left, sf), b: liftExpr(e.right, sf) };
  }
  if (ts.isConditionalExpression(e)) {
    return { t: "cond", cond: liftExpr(e.condition, sf), then: liftExpr(e.whenTrue, sf), else: liftExpr(e.whenFalse, sf) };
  }
  if (ts.isArrayLiteralExpression(e)) {
    return { t: "array", elems: e.elements.map((el) => liftExpr(el, sf)) };
  }
  if (ts.isCallExpression(e)) {
    const args = e.arguments.map((a) => liftExpr(a, sf));
    // `this.method(...)` is a method call on the ambient receiver — captured with
    // an explicit `self` recv so it round-trips (a dotted "this.method" name has no
    // local base for `to-ir` to classify). Every other callee keeps its verbatim
    // dotted text; `to-ir` decides link / package / local-method / stub from it.
    if (
      ts.isPropertyAccessExpression(e.expression) &&
      e.expression.expression.kind === ts.SyntaxKind.ThisKeyword
    ) {
      return { t: "call", name: e.expression.name.text, recv: { t: "self" }, args };
    }
    return { t: "call", name: e.expression.getText(sf), args };
  }
  throw new Error(`lift(ts): unsupported expression "${ts.SyntaxKind[e.kind]}"`);
}
