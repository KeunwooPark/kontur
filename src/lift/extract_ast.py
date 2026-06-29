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
    if isinstance(e, ast.Call) and isinstance(e.func, ast.Name):
        return {"t": "call", "name": e.func.id, "args": [expr(a) for a in e.args]}
    raise SystemExit("lift(py): unsupported expr: " + ast.dump(e))


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
        start = expr(args[0])
        stop = args[1]
        # Inverse of the inclusive-loop lowering: range(from, to + 1) -> to.
        if isinstance(stop, ast.BinOp) and isinstance(stop.op, ast.Add) and isinstance(stop.right, ast.Constant) and stop.right.value == 1:
            to = expr(stop.left)
        else:
            to = {"t": "bin", "op": "sub", "a": expr(stop), "b": {"t": "lit", "value": 1}}
        return {"t": "for", "varName": s.target.id, "from": start, "to": to, "body": [stmt(x) for x in s.body]}
    if isinstance(s, ast.Expr) and isinstance(s.value, ast.Call) and isinstance(s.value.func, ast.Name):
        if s.value.func.id == "print":
            return {"t": "print", "arg": expr(s.value.args[0])}
        return {"t": "expr", "expr": expr(s.value)}
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
