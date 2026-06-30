"""
Parse a Python source string (from stdin) into Kontur's neutral AST as JSON.
Handles the subset our Python emitter produces. Errors out loudly on anything
outside that subset rather than guessing.
"""
import ast
import json
import sys

TYPE_MAP = {"int": "int", "float": "float", "str": "string", "bool": "bool"}
BINOP = {ast.Add: "add", ast.Sub: "sub", ast.Mult: "mul", ast.Div: "div", ast.Mod: "mod"}
CMP = {ast.Eq: "eq", ast.NotEq: "ne", ast.Lt: "lt", ast.LtE: "le", ast.Gt: "gt", ast.GtE: "ge"}

# Local names bound by imports (filled before walking the body). A `base.attr(...)`
# call is only accepted when `base` is one of these — so a package member call
# (`math.sqrt(x)`) lifts, while a self/local member call stays a loud reject.
IMPORTED_NAMES = set()


def call_name(func):
    """The dotted callee name of a Call, or None if it is not a supported shape.
    A plain `name(...)` is always allowed; `base.attr(...)` only when `base` is an
    imported name (otherwise it is a self/local member access we do not model)."""
    if isinstance(func, ast.Name):
        return func.id
    if isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name) and func.value.id in IMPORTED_NAMES:
        return func.value.id + "." + func.attr
    return None


def map_type(node):
    if isinstance(node, ast.Name):
        return TYPE_MAP.get(node.id, node.id)
    return "any"


def span(node):
    """Provenance: the source range a node was lifted from. `line` is 1-based,
    `col` 0-based (CPython's convention). Returns None if positions are absent."""
    if not hasattr(node, "lineno") or node.end_lineno is None:
        return None
    return {
        "start": {"line": node.lineno, "col": node.col_offset},
        "end": {"line": node.end_lineno, "col": node.end_col_offset},
    }


def expr(e):
    if isinstance(e, ast.Constant):
        return {"t": "lit", "value": e.value}
    if isinstance(e, ast.Name):
        return {"t": "var", "name": e.id}
    if isinstance(e, ast.Attribute) and isinstance(e.value, ast.Name) and e.value.id == "self":
        return {"t": "stateGet", "attr": e.attr}
    if isinstance(e, ast.Subscript) and isinstance(e.value, ast.Name) and isinstance(e.slice, ast.Constant):
        return {"t": "member", "name": e.value.id, "member": e.slice.value}
    if isinstance(e, ast.BinOp) and type(e.op) in BINOP:
        return {"t": "bin", "op": BINOP[type(e.op)], "a": expr(e.left), "b": expr(e.right)}
    if isinstance(e, ast.Compare) and len(e.ops) == 1:
        return {"t": "bin", "op": CMP[type(e.ops[0])], "a": expr(e.left), "b": expr(e.comparators[0])}
    if isinstance(e, ast.BoolOp):
        op = "and" if isinstance(e.op, ast.And) else "or"
        cur = expr(e.values[0])
        for v in e.values[1:]:
            cur = {"t": "bin", "op": op, "a": cur, "b": expr(v)}
        return cur
    if isinstance(e, ast.UnaryOp) and isinstance(e.op, ast.Not):
        return {"t": "un", "op": "not", "x": expr(e.operand)}
    if isinstance(e, ast.IfExp):
        return {"t": "cond", "cond": expr(e.test), "then": expr(e.body), "else": expr(e.orelse)}
    if isinstance(e, ast.List):
        return {"t": "array", "elems": [expr(el) for el in e.elts]}
    if (
        isinstance(e, ast.ListComp)
        and len(e.generators) == 1
        and not e.generators[0].ifs
        and isinstance(e.generators[0].target, ast.Name)
        and isinstance(e.generators[0].iter, ast.Call)
        and isinstance(e.generators[0].iter.func, ast.Name)
        and e.generators[0].iter.func.id == "range"
        and len(e.generators[0].iter.args) == 2
    ):
        gen = e.generators[0]
        start, stop = gen.iter.args[0], gen.iter.args[1]
        return {
            "t": "comprehension",
            "varName": gen.target.id,
            "from": expr(start),
            "to": range_stop_to(stop),
            "elem": expr(e.elt),
        }
    if isinstance(e, ast.Call) and call_name(e.func) is not None:
        return {"t": "call", "name": call_name(e.func), "args": [expr(a) for a in e.args]}
    raise SystemExit("lift(py): unsupported expr: " + ast.dump(e))


def range_stop_to(stop):
    """Inverse of the inclusive-range lowering: range(from, to + 1) -> to."""
    if (
        isinstance(stop, ast.BinOp)
        and isinstance(stop.op, ast.Add)
        and isinstance(stop.right, ast.Constant)
        and stop.right.value == 1
    ):
        return expr(stop.left)
    return {"t": "bin", "op": "sub", "a": expr(stop), "b": {"t": "lit", "value": 1}}


def stmt(s):
    """Lower a statement and stamp its source span (provenance) onto the result."""
    d = _stmt(s)
    sp = span(s)
    if sp is not None:
        d["span"] = sp
    return d


def _stmt(s):
    if (
        isinstance(s, ast.Assign)
        and len(s.targets) == 1
        and isinstance(s.targets[0], ast.Attribute)
        and isinstance(s.targets[0].value, ast.Name)
        and s.targets[0].value.id == "self"
    ):
        return {"t": "stateSet", "attr": s.targets[0].attr, "value": expr(s.value)}
    if isinstance(s, ast.Assign) and len(s.targets) == 1 and isinstance(s.targets[0], ast.Name):
        return {"t": "let", "name": s.targets[0].id, "expr": expr(s.value)}
    if isinstance(s, ast.Return):
        return {"t": "return", "expr": expr(s.value)}
    if isinstance(s, ast.If):
        return {
            "t": "if",
            "cond": expr(s.test),
            "then": [stmt(x) for x in s.body],
            "else": [stmt(x) for x in s.orelse],
        }
    if isinstance(s, ast.For) and isinstance(s.iter, ast.Call) and isinstance(s.iter.func, ast.Name) and s.iter.func.id == "range":
        args = s.iter.args
        return {
            "t": "for",
            "varName": s.target.id,
            "from": expr(args[0]),
            "to": range_stop_to(args[1]),
            "body": [stmt(x) for x in s.body],
        }
    if isinstance(s, ast.For):
        # A non-range `for x in iter:` is a collection-driven loop (foreach). Only
        # a single Name target is modelled; tuple unpacking or a for/else clause is
        # control flow with no IR node, so refuse it rather than drop it.
        if not isinstance(s.target, ast.Name):
            raise SystemExit("lift(py): unsupported for-target (only a single name, not unpacking)")
        if s.orelse:
            raise SystemExit("lift(py): unsupported for/else (no IR node for the else clause)")
        return {
            "t": "foreach",
            "varName": s.target.id,
            "iter": expr(s.iter),
            "body": [stmt(x) for x in s.body],
        }
    if isinstance(s, ast.Expr) and isinstance(s.value, ast.Call) and call_name(s.value.func) is not None:
        if isinstance(s.value.func, ast.Name) and s.value.func.id == "print":
            return {"t": "print", "arg": expr(s.value.args[0])}
        return {"t": "expr", "expr": expr(s.value)}
    if isinstance(s, ast.Raise):
        # Two raising shapes are modelled, mirroring the two IR nodes:
        #   raise Exception(msg) -> throw    (construct a fresh error from a message)
        #   raise e              -> rethrow   (re-raise an existing value unchanged)
        # Constructing any single-arg exception type maps too: the constructor name
        # rides on the throw node's `errorType` (`Exception` stays the catch-all
        # default, left implicit). A bare `raise`, a `from` cause, or a non-call /
        # non-name value is beyond the model, so it is refused, not approximated.
        exc = s.exc
        if (
            s.cause is None
            and isinstance(exc, ast.Call)
            and isinstance(exc.func, ast.Name)
            and len(exc.args) == 1
        ):
            node = {"t": "throw", "arg": expr(exc.args[0])}
            if exc.func.id != "Exception":
                node["errorType"] = exc.func.id
            return node
        if s.cause is None and isinstance(exc, ast.Name):
            return {"t": "rethrow", "value": {"t": "var", "name": exc.id}}
        raise SystemExit("lift(py): unsupported raise (only `raise <Exception>(message)` or re-raising a value `raise e` is modelled)")
    if isinstance(s, ast.Try):
        # The IR models a single catch-all handler with no exception type. Refuse
        # finally/else and multiple/typed handlers rather than silently drop the
        # type info or non-local control flow we cannot faithfully reproduce.
        if s.finalbody or s.orelse:
            raise SystemExit("lift(py): unsupported try/finally or try/else (no IR node)")
        if len(s.handlers) != 1:
            raise SystemExit("lift(py): unsupported try with multiple/zero except handlers")
        h = s.handlers[0]
        if not (h.type is None or (isinstance(h.type, ast.Name) and h.type.id == "Exception")):
            raise SystemExit("lift(py): unsupported typed except (IR catch is catch-all)")
        out = {
            "t": "try",
            "body": [stmt(x) for x in s.body],
            "handler": [stmt(x) for x in h.body],
        }
        if h.name:
            out["catchParam"] = h.name
        return out
    raise SystemExit("lift(py): unsupported stmt: " + ast.dump(s))


def docstring_of(body):
    """The PEP 257 docstring of a body: a leading bare string-literal statement.
    Returns (doc, rest) with that statement removed, or (None, body) if absent.
    Captured (not executed code) so it round-trips instead of blocking the parse —
    a function/class docstring is the first statement of nearly every real file."""
    if (
        body
        and isinstance(body[0], ast.Expr)
        and isinstance(body[0].value, ast.Constant)
        and isinstance(body[0].value.value, str)
    ):
        return body[0].value.value, body[1:]
    return None, body


def is_void(rt):
    if rt is None:
        return True
    if isinstance(rt, ast.Constant) and rt.value is None:
        return True
    if isinstance(rt, ast.Name) and rt.id == "None":
        return True
    return False


def func(f, is_method=False):
    args = f.args.args
    # A method's leading `self` is implicit in the IR; drop it.
    if is_method and args and args[0].arg == "self":
        args = args[1:]
    params = [{"name": a.arg, "type": map_type(a.annotation)} for a in args]
    returns = [] if is_void(f.returns) else [{"name": "result", "type": map_type(f.returns)}]
    doc, body = docstring_of(f.body)
    out = {"name": f.name, "params": params, "returns": returns, "body": [stmt(x) for x in body]}
    if doc is not None:
        out["doc"] = doc
    if is_method:
        out["isMethod"] = True
    sp = span(f)
    if sp is not None:
        out["span"] = sp
    return out


def klass(c):
    fields = []
    methods = []
    doc, body = docstring_of(c.body)
    for n in body:
        if isinstance(n, ast.AnnAssign) and isinstance(n.target, ast.Name):
            fields.append({"name": n.target.id, "type": map_type(n.annotation)})
        elif isinstance(n, ast.FunctionDef):
            methods.append(func(n, is_method=True))
        elif isinstance(n, ast.Pass):
            continue
        else:
            raise SystemExit("lift(py): unsupported class member: " + ast.dump(n))
    out = {"name": c.name, "fields": fields, "methods": methods}
    if doc is not None:
        out["doc"] = doc
    sp = span(c)
    if sp is not None:
        out["span"] = sp
    return out


def imports_of(tree):
    """Collect import statements verbatim so the transpiler can reproduce them.
    `import a, b` and `from m import a, b` each yield one Import per module
    specifier. A relative import (`from .x import y`) keeps its leading dots in the
    `source` specifier, so it round-trips verbatim and the multi-file driver can
    resolve the dots against the package path into a cross-file link. Only star
    imports stay refused — they bind names we cannot see."""
    out = []
    for n in tree.body:
        sp = span(n)
        if isinstance(n, ast.Import):
            # `import a as x, b` → one namespace binding per module name.
            for alias in n.names:
                b = {"kind": "namespace", "local": alias.asname or alias.name}
                d = {"source": alias.name, "bindings": [b]}
                if sp is not None:
                    d["span"] = sp
                out.append(d)
        elif isinstance(n, ast.ImportFrom):
            if any(a.name == "*" for a in n.names):
                raise SystemExit("lift(py): unsupported star import (`from m import *` binds names we cannot see)")
            # Reconstruct the literal specifier: `level` leading dots, then the
            # (possibly empty) dotted module. `from . import x` → ".";
            # `from .x import y` → ".x"; `from ..a.b import z` → "..a.b".
            source = "." * n.level + (n.module or "")
            bindings = [{"kind": "named", "imported": a.name, "local": a.asname or a.name} for a in n.names]
            d = {"source": source, "bindings": bindings}
            if sp is not None:
                d["span"] = sp
            out.append(d)
    return out


tree = ast.parse(sys.stdin.read())
imports = imports_of(tree)
IMPORTED_NAMES = {b["local"] for imp in imports for b in imp["bindings"]}
functions = [func(n) for n in tree.body if isinstance(n, ast.FunctionDef)]
classes = [klass(n) for n in tree.body if isinstance(n, ast.ClassDef)]
print(json.dumps({"functions": functions, "classes": classes, "imports": imports}))
