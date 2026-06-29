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


def map_type(node):
    if isinstance(node, ast.Name):
        return TYPE_MAP.get(node.id, node.id)
    return "any"


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
    if isinstance(e, ast.Call) and isinstance(e.func, ast.Name):
        return {"t": "call", "name": e.func.id, "args": [expr(a) for a in e.args]}
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
    if isinstance(s, ast.Expr) and isinstance(s.value, ast.Call) and isinstance(s.value.func, ast.Name):
        if s.value.func.id == "print":
            return {"t": "print", "arg": expr(s.value.args[0])}
        return {"t": "expr", "expr": expr(s.value)}
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
    out = {"name": f.name, "params": params, "returns": returns, "body": [stmt(x) for x in f.body]}
    if is_method:
        out["isMethod"] = True
    return out


def klass(c):
    fields = []
    methods = []
    for n in c.body:
        if isinstance(n, ast.AnnAssign) and isinstance(n.target, ast.Name):
            fields.append({"name": n.target.id, "type": map_type(n.annotation)})
        elif isinstance(n, ast.FunctionDef):
            methods.append(func(n, is_method=True))
        elif isinstance(n, ast.Pass):
            continue
        else:
            raise SystemExit("lift(py): unsupported class member: " + ast.dump(n))
    return {"name": c.name, "fields": fields, "methods": methods}


tree = ast.parse(sys.stdin.read())
functions = [func(n) for n in tree.body if isinstance(n, ast.FunctionDef)]
classes = [klass(n) for n in tree.body if isinstance(n, ast.ClassDef)]
print(json.dumps({"functions": functions, "classes": classes}))
