/**
 * A tiny language-neutral AST that sits between the Kontur IR graph and the
 * concrete backends. `compile.ts` lowers the graph into this; each emitter
 * (TS, Python) renders this to source. Keeping it shared means control-flow
 * analysis happens once and the backends only differ in syntax.
 */
import type { Op } from "../ir/schema.js";

export type Expr =
  | { t: "lit"; value: unknown }
  | { t: "var"; name: string }
  /** Member access on a multi-output module-call result: `name.member`. */
  | { t: "member"; name: string; member: string }
  /** Read an attribute of the enclosing class: `this.attr` / `self.attr`. */
  | { t: "stateGet"; attr: string }
  | { t: "bin"; op: Op; a: Expr; b: Expr }
  | { t: "un"; op: Op; x: Expr }
  /** A value-level conditional (ternary): `cond ? then : else`. */
  | { t: "cond"; cond: Expr; then: Expr; else: Expr }
  /** A list literal: `[e0, e1, …]`. */
  | { t: "array"; elems: Expr[] }
  /** A list comprehension over an inclusive range: `[elem for v in from..to]`. */
  | { t: "comprehension"; varName: string; from: Expr; to: Expr; elem: Expr }
  /** A call to a generated function: a helper (stub) or another module. */
  | { t: "call"; name: string; args: Expr[] };

export type Stmt =
  | { t: "let"; name: string; expr: Expr }
  /** Reassign an existing binding: `name = expr` / `name += …`. */
  | { t: "assign"; name: string; expr: Expr }
  | { t: "expr"; expr: Expr }
  | { t: "print"; arg: Expr }
  /** Write an attribute of the enclosing class: `this.attr = value`. */
  | { t: "stateSet"; attr: string; value: Expr }
  | { t: "if"; cond: Expr; then: Stmt[]; else: Stmt[] }
  /** Inclusive counted loop: `for v in from..to`. */
  | { t: "for"; varName: string; from: Expr; to: Expr; body: Stmt[] }
  /** Condition-driven loop: `while cond { … }`. */
  | { t: "while"; cond: Expr; body: Stmt[] }
  | { t: "return"; expr: Expr }
  /** Return several named values (multi-output module). */
  | { t: "returnObject"; fields: { name: string; expr: Expr }[] };

export interface Param {
  name: string;
  /** IR type label (e.g. "int", "User"); emitters map it per backend. */
  type: string;
}

export interface Fn {
  /** Source module id (cased per backend at emit time). */
  name: string;
  params: Param[];
  /** Data out-port types, in declared order. Empty → no return value. */
  returns: { name: string; type: string }[];
  body: Stmt[];
  /** When true, emit as a class method (no `export function`, `self`/`this`). */
  isMethod?: boolean;
}

/** A class attribute: a typed, stored cell. */
export interface Field {
  name: string;
  type: string;
}

/** A class: stored state (attributes) plus methods (each a module/Fn). */
export interface Class {
  /** Source class id (cased to PascalCase at emit time). */
  name: string;
  fields: Field[];
  methods: Fn[];
}

export interface Program {
  functions: Fn[];
  classes: Class[];
}
