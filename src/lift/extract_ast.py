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
CMP = {ast.Eq: "eq", ast.NotEq: "ne", ast.Lt: "lt", ast.LtE: "le", ast.Gt: "gt", ast.GtE: "ge",
       ast.Is: "is", ast.IsNot: "isnot", ast.In: "in", ast.NotIn: "notin"}
# Prefix unary operators sharing the `un` node: logical `not`, arithmetic `-`/`+`,
# bitwise `~`. All round-trip through both emitters (`-x`, `+x`, `~x`, `not x`).
UNARYOP = {ast.Not: "not", ast.USub: "neg", ast.UAdd: "pos", ast.Invert: "bitnot"}

# Local names bound by imports (filled before walking the body). A `base.attr(...)`
# call is only accepted when `base` is one of these — so a package member call
# (`math.sqrt(x)`) lifts, while a self/local member call stays a loud reject.
IMPORTED_NAMES = set()
# Module-level constant names (filled before walking bodies). A bare reference to
# one is a free identifier (`{t:"global"}`), re-declared at module scope.
MODULE_GLOBALS = set()


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


def call_args(e):
    """The argument structure of a Call: plain positional `args`, `*x` positional
    unpacks (`starArgs`), and keyword args (`kwargs`: `name=value` as {name,value},
    `**value` as {name:None,value}). Capturing all three closes a silent-drop hole —
    keyword/star args were previously ignored, so `f(x=1, **kw)` lifted to `f()`."""
    args = [expr(a) for a in e.args if not isinstance(a, ast.Starred)]
    star_args = [expr(a.value) for a in e.args if isinstance(a, ast.Starred)]
    kwargs = [{"name": k.arg, "value": expr(k.value)} for k in e.keywords]
    out = {"args": args}
    if star_args:
        out["starArgs"] = star_args
    if kwargs:
        out["kwargs"] = kwargs
    return out


def unpack_target_names(target):
    """The list of plain names bound by a tuple/list unpack target (`a, b`), or
    None if `target` is not a tuple/list. Only plain names are modelled: a starred
    (`a, *rest`) or nested (`(a, b), c`) target is a distinct construct, refused
    loudly. Shared by destructuring assignment, for-targets, and comprehensions."""
    if not isinstance(target, (ast.Tuple, ast.List)):
        return None
    if len(target.elts) < 2:
        raise SystemExit("lift(py): unsupported single-element unpack target (`(a,) = …`, deferred)")
    names = []
    for el in target.elts:
        if isinstance(el, ast.Starred):
            raise SystemExit("lift(py): unsupported starred unpack target (`a, *rest`, deferred)")
        if not isinstance(el, ast.Name):
            raise SystemExit("lift(py): unsupported nested unpack target (only plain names, deferred)")
        names.append(el.id)
    return names


def span(node):
    """Provenance: the source range a node was lifted from. `line` is 1-based,
    `col` 0-based (CPython's convention). Returns None if positions are absent."""
    if not hasattr(node, "lineno") or node.end_lineno is None:
        return None
    return {
        "start": {"line": node.lineno, "col": node.col_offset},
        "end": {"line": node.end_lineno, "col": node.end_col_offset},
    }


def attr_root(e):
    """The leftmost Name at the base of an Attribute/Subscript chain, or None."""
    while isinstance(e, (ast.Attribute, ast.Subscript)):
        e = e.value
    return e if isinstance(e, ast.Name) else None


def expr(e):
    if isinstance(e, ast.Constant):
        return {"t": "lit", "value": e.value}
    # A lambda is an anonymous function that captures its enclosing scope (a
    # closure). The IR models functions as named, flat modules with explicit
    # param/return boundaries — it has no anonymous-function node and no closure
    # capture — so a lambda is refused loudly (deferred), not approximated.
    if isinstance(e, ast.Lambda):
        raise SystemExit("lift(py): unsupported lambda (anonymous function / closure capture has no IR node, deferred)")
    if isinstance(e, ast.NamedExpr):
        raise SystemExit("lift(py): unsupported walrus assignment expression (`x := y`, deferred)")
    # `self` is the ambient method receiver, never a value on its own; it only
    # rides as the receiver of a method call or the base of `self.attr`.
    if isinstance(e, ast.Name) and e.id == "self":
        return {"t": "self"}
    if isinstance(e, ast.Name) and e.id in MODULE_GLOBALS:
        # A reference to a module-level constant — a free identifier, emitted
        # verbatim and re-declared at module scope (round-trips, like an import).
        return {"t": "global", "name": e.id}
    if isinstance(e, ast.Name):
        return {"t": "var", "name": e.id}
    if isinstance(e, ast.Attribute) and isinstance(e.value, ast.Name) and e.value.id == "self":
        return {"t": "stateGet", "attr": e.attr}
    # A constant-STRING subscript on a bare name is a field of a multi-output
    # result (`r["status"]`) — the `member` port accessor. Restricted to strings:
    # the port names a multi-output module exposes are strings, and this is the
    # round-trip inverse of how the transpiler emits one. Any other subscript
    # (a non-string key, a variable key, a receiver that is not a bare name, or a
    # slice) is a general runtime index/slice, handled just below.
    if (
        isinstance(e, ast.Subscript)
        and isinstance(e.value, ast.Name)
        and isinstance(e.slice, ast.Constant)
        and isinstance(e.slice.value, str)
    ):
        return {"t": "member", "name": e.value.id, "member": e.slice.value}
    # A slice subscript `obj[start:stop]` -> a `slice` node (Python-faithful; TS
    # cross-compiles one-way to `.slice`). Either bound may be absent (an open
    # end). A step (`obj[::2]`) has no `.slice` form, so refuse it loudly (deferred).
    if isinstance(e, ast.Subscript) and isinstance(e.slice, ast.Slice):
        sl = e.slice
        if sl.step is not None:
            raise SystemExit("lift(py): unsupported slice step (`a[::2]`, deferred)")
        out = {"t": "slice", "obj": expr(e.value)}
        if sl.lower is not None:
            out["start"] = expr(sl.lower)
        if sl.upper is not None:
            out["stop"] = expr(sl.upper)
        return out
    # A general subscript read `obj[key]` -> an `index` node: the indexed value on
    # "obj", the key on "key". Covers a variable key (`a[i]`), a non-string const
    # (`a[0]`), and a non-name receiver (`split(s)[0]`). Round-trips in both backends.
    if isinstance(e, ast.Subscript):
        return {"t": "index", "obj": expr(e.value), "key": expr(e.slice)}
    if isinstance(e, ast.BinOp) and type(e.op) in BINOP:
        return {"t": "bin", "op": BINOP[type(e.op)], "a": expr(e.left), "b": expr(e.right)}
    if isinstance(e, ast.Compare) and all(type(o) in CMP for o in e.ops):
        # A chained comparison `a <= b < c` desugars to `(a <= b) and (b < c)` — a
        # source-level fixed point (re-lift sees the `and` form; the `and` chain is
        # stable). The desugar EVALUATES each middle operand TWICE, so it is refused
        # unless the middle operands are side-effect-free (never double-run a call).
        operands = [e.left] + list(e.comparators)
        for mid in operands[1:-1]:
            if not is_pure(mid):
                raise SystemExit("lift(py): unsupported chained comparison with a non-pure middle operand (would double-evaluate a side effect)")
        terms = [{"t": "bin", "op": CMP[type(o)], "a": expr(operands[i]), "b": expr(operands[i + 1])} for i, o in enumerate(e.ops)]
        cur = terms[0]
        for t in terms[1:]:
            cur = {"t": "bin", "op": "and", "a": cur, "b": t}
        return cur
    if isinstance(e, ast.BoolOp):
        op = "and" if isinstance(e.op, ast.And) else "or"
        cur = expr(e.values[0])
        for v in e.values[1:]:
            cur = {"t": "bin", "op": op, "a": cur, "b": expr(v)}
        return cur
    if isinstance(e, ast.UnaryOp) and type(e.op) in UNARYOP:
        return {"t": "un", "op": UNARYOP[type(e.op)], "x": expr(e.operand)}
    if isinstance(e, ast.JoinedStr):
        return joined_str(e)
    if isinstance(e, ast.IfExp):
        return {"t": "cond", "cond": expr(e.test), "then": expr(e.body), "else": expr(e.orelse)}
    if isinstance(e, ast.List):
        return {"t": "array", "elems": [expr(el) for el in e.elts]}
    # Tuple/set/dict literals -> a `collection` node (the array sibling). A starred
    # element (`[*xs]`/`(*xs,)`) or dict-spread (`{**d}`) is a different construct
    # with no IR home yet, so refuse it loudly rather than drop it.
    if isinstance(e, ast.Tuple):
        if any(isinstance(el, ast.Starred) for el in e.elts):
            raise SystemExit("lift(py): unsupported starred element in a tuple literal (deferred)")
        return {"t": "collection", "form": "tuple", "elems": [expr(el) for el in e.elts]}
    if isinstance(e, ast.Set):
        if any(isinstance(el, ast.Starred) for el in e.elts):
            raise SystemExit("lift(py): unsupported starred element in a set literal (deferred)")
        return {"t": "collection", "form": "set", "elems": [expr(el) for el in e.elts]}
    if isinstance(e, ast.Dict):
        if any(k is None for k in e.keys):
            raise SystemExit("lift(py): unsupported dict-unpacking entry (`{**d}`, deferred)")
        return {"t": "collection", "form": "dict",
                "entries": [{"key": expr(k), "value": expr(v)} for k, v in zip(e.keys, e.values)]}
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
    if isinstance(e, ast.Await):
        return {"t": "await", "value": expr(e.value)}
    if isinstance(e, (ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)):
        return iter_comp(e)
    if isinstance(e, ast.Call) and call_name(e.func) is not None:
        return {"t": "call", "name": call_name(e.func), **call_args(e)}
    # A method call on a self/local receiver: `recv.method(args)`. The imported-base
    # case (`pkg.fn(...)`) was taken above via call_name; what remains is a receiver
    # we model as a value flowing into the call. A bare imported name as the receiver
    # of a deeper read is a package value reference we do not model yet (see below).
    if isinstance(e, ast.Call) and isinstance(e.func, ast.Attribute):
        root = attr_root(e.func.value)
        if root is not None and root.id in IMPORTED_NAMES:
            raise SystemExit("lift(py): unsupported call on an imported value (package member chain, deferred): " + ast.dump(e.func))
        return {"t": "call", "name": e.func.attr, **call_args(e), "recv": expr(e.func.value)}
    # A general attribute read `obj.attr` (self.attr was taken above as stateGet).
    # A read off an imported name (`sys.maxsize`) is a package value reference with
    # no receiver wire — a distinct construct, deferred, refused loudly.
    if isinstance(e, ast.Attribute):
        root = attr_root(e.value)
        if root is not None and root.id in IMPORTED_NAMES:
            raise SystemExit("lift(py): unsupported attribute read on an imported name (package value reference, deferred): " + ast.dump(e))
        return {"t": "attr", "obj": expr(e.value), "name": e.attr}
    raise SystemExit("lift(py): unsupported expr: " + ast.dump(e))


ITERCOMP_FORM = {
    ast.ListComp: "list",
    ast.SetComp: "set",
    ast.DictComp: "dict",
    ast.GeneratorExp: "generator",
}


def iter_comp(e):
    """A comprehension over an arbitrary iterable -> an `itercomp` expr: the
    value-producing sibling of a `foreach`, covering list/set/dict/generator forms
    with an optional single `if` filter. Distinct from the counted-range list comp
    above (which keeps its dedicated `comprehension` node). A single Name target binds
    `varName`; a tuple target (`for k, v in ...`) binds `varNames` (the unpacking item).
    Multiple generators, an `async for`, and more than one filter are each a separate
    construct, refused loudly and deferred."""
    if len(e.generators) != 1:
        raise SystemExit("lift(py): unsupported multi-generator comprehension (deferred)")
    g = e.generators[0]
    if getattr(g, "is_async", 0):
        raise SystemExit("lift(py): unsupported async comprehension (deferred)")
    if len(g.ifs) > 1:
        raise SystemExit("lift(py): unsupported comprehension with multiple if-filters (deferred)")
    out = {"t": "itercomp", "form": ITERCOMP_FORM[type(e)], "iter": expr(g.iter)}
    if isinstance(g.target, ast.Name):
        out["varName"] = g.target.id
    else:
        out["varNames"] = unpack_target_names(g.target)
    if isinstance(e, ast.DictComp):
        out["key"] = expr(e.key)
        out["value"] = expr(e.value)
    else:
        out["elem"] = expr(e.elt)
    if g.ifs:
        out["cond"] = expr(g.ifs[0])
    return out


def joined_str(e):
    """An f-string lowers to a left-folded `concat` chain over its literal text
    and interpolated expressions — the same shape the TS lifter produces for a
    template literal (see `liftTemplate` in ast-from-ts.ts). The IR has no
    interpolation node; `concat` is the string-join effect, emitted as `+` by each
    backend. Empty fixed parts are dropped so the chain carries only text-producing
    pieces; an f-string with no parts is the empty string. A conversion (`{x!r}`)
    or a format spec (`{x:.2f}`) carries formatting that `concat` cannot represent,
    so refuse it loudly rather than silently drop it."""
    parts = []
    for v in e.values:
        if isinstance(v, ast.Constant):
            if v.value != "":
                parts.append({"t": "lit", "value": v.value})
        elif isinstance(v, ast.FormattedValue):
            if v.conversion != -1 or v.format_spec is not None:
                raise SystemExit("lift(py): unsupported f-string conversion/format spec (e.g. {x!r} / {x:.2f}; not representable as concat)")
            parts.append(expr(v.value))
        else:
            raise SystemExit("lift(py): unsupported f-string part: " + ast.dump(v))
    if not parts:
        return {"t": "lit", "value": ""}
    cur = parts[0]
    for p in parts[1:]:
        cur = {"t": "bin", "op": "concat", "a": cur, "b": p}
    return cur


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
    # Chained assignment `x = y = z` binds one value to several names (broadcast).
    # Only plain-name targets are modelled (an attribute/subscript chain target is
    # rarer and refused). The value is evaluated once via the `broadcast` node.
    if isinstance(s, ast.Assign) and len(s.targets) > 1:
        if all(isinstance(t, ast.Name) for t in s.targets):
            return {"t": "chain", "names": [t.id for t in s.targets], "value": expr(s.value)}
        raise SystemExit("lift(py): unsupported chained assignment target (only plain names)")
    # Sequence unpacking `a, b = value` (a tuple/list target). Each name binds to
    # the corresponding element of `value` -> a `destructure` (the `unpack` node).
    # Only plain names are modelled: a starred target (`a, *rest = …`) or a nested
    # one (`(a, b), c = …`) is a distinct construct with no IR home, refused loudly.
    if isinstance(s, ast.Assign) and len(s.targets) == 1 and isinstance(s.targets[0], (ast.Tuple, ast.List)):
        return {"t": "destructure", "names": unpack_target_names(s.targets[0]), "value": expr(s.value)}
    # An attribute-assignment target on an arbitrary receiver: `obj.attr = v` (the
    # `self.attr` case was taken above as stateSet). The write-side sibling of an
    # `attr` read — a control-sequenced effect with the receiver wired in.
    if isinstance(s, ast.Assign) and len(s.targets) == 1 and isinstance(s.targets[0], ast.Attribute):
        t = s.targets[0]
        return {"t": "attrSet", "obj": expr(t.value), "attr": t.attr, "value": expr(s.value)}
    # A subscript-assignment target: `d[k] = v`. The write-side sibling of an
    # `index` read — the general lvalue. A slice-assignment target (`d[1:3] = v`)
    # has no IR home yet (it overwrites a span, not one cell), so refuse it loudly.
    if isinstance(s, ast.Assign) and len(s.targets) == 1 and isinstance(s.targets[0], ast.Subscript):
        t = s.targets[0]
        if isinstance(t.slice, ast.Slice):
            raise SystemExit("lift(py): unsupported slice-assignment target (`d[1:3] = v`, deferred)")
        return {"t": "indexSet", "obj": expr(t.value), "key": expr(t.slice), "value": expr(s.value)}
    if isinstance(s, ast.AnnAssign):
        # An annotated assignment `x: T = v`. The IR treats locals untyped (only
        # params/returns carry types), so the annotation is dropped and the
        # statement normalizes to the matching plain-assignment shape — a source
        # rewrite (`x: T = v` → `x = v`), a fixed point thereafter. A bare
        # annotation with NO value (`x: T`, a forward declaration) carries no
        # dataflow, so it is refused rather than invented.
        if s.value is None:
            raise SystemExit("lift(py): unsupported bare annotation (`x: T` with no value, forward declaration)")
        if isinstance(s.target, ast.Name):
            return {"t": "let", "name": s.target.id, "expr": expr(s.value)}
        if isinstance(s.target, ast.Attribute) and isinstance(s.target.value, ast.Name) and s.target.value.id == "self":
            return {"t": "stateSet", "attr": s.target.attr, "value": expr(s.value)}
        if isinstance(s.target, ast.Attribute):
            return {"t": "attrSet", "obj": expr(s.target.value), "attr": s.target.attr, "value": expr(s.value)}
        raise SystemExit("lift(py): unsupported annotated-assignment target")
    if isinstance(s, ast.AugAssign):
        # `x += y` desugars to `x = x + y` — the augmented op unfolds to the plain
        # binary op over the target's CURRENT value and the RHS. This mirrors the TS
        # lifter (AUG_OP in ast-from-ts.ts), so both backends produce the same IR; it
        # is a SOURCE-level fixed point (the first transpile rewrites `+=` to `x = x + y`,
        # like f-strings). Only the binary ops we model are accepted; a `**=`/`//=`/
        # bit-op augmentation refuses loudly. Every lvalue the IR can write is an
        # augmentation target: a bare name (`assign`), `self.attr` (`stateSet`), a
        # general `obj.attr` (`attrSet`), or a subscript `d[k]` (`indexSet`). Each
        # desugars to `lhs = lhs <op> rhs`, reading the CURRENT value before the
        # write — a SOURCE-level fixed point (the first transpile rewrites `+=`).
        if type(s.op) not in BINOP:
            raise SystemExit("lift(py): unsupported augmented-assignment operator (only += -= *= /= %= are modelled)")
        op = BINOP[type(s.op)]
        if isinstance(s.target, ast.Name):
            cur = {"t": "var", "name": s.target.id}
            return {"t": "assign", "name": s.target.id, "expr": {"t": "bin", "op": op, "a": cur, "b": expr(s.value)}}
        if isinstance(s.target, ast.Attribute) and isinstance(s.target.value, ast.Name) and s.target.value.id == "self":
            cur = {"t": "stateGet", "attr": s.target.attr}
            return {"t": "stateSet", "attr": s.target.attr, "value": {"t": "bin", "op": op, "a": cur, "b": expr(s.value)}}
        if isinstance(s.target, ast.Attribute):
            obj = expr(s.target.value)
            cur = {"t": "attr", "obj": obj, "name": s.target.attr}
            return {"t": "attrSet", "obj": obj, "attr": s.target.attr, "value": {"t": "bin", "op": op, "a": cur, "b": expr(s.value)}}
        if isinstance(s.target, ast.Subscript):
            if isinstance(s.target.slice, ast.Slice):
                raise SystemExit("lift(py): unsupported slice-assignment target (`d[1:3] += v`, deferred)")
            obj, key = expr(s.target.value), expr(s.target.slice)
            cur = {"t": "index", "obj": obj, "key": key}
            return {"t": "indexSet", "obj": obj, "key": key, "value": {"t": "bin", "op": op, "a": cur, "b": expr(s.value)}}
        raise SystemExit("lift(py): unsupported augmented-assignment target")
    if isinstance(s, ast.Return):
        # A bare `return` (or `return None`) is a void early exit — a `return` node
        # with no value pin (multi-exit control flow). A value return carries its expr.
        if s.value is None:
            return {"t": "return"}
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
    if isinstance(s, ast.While):
        # A condition-driven loop. The IR `while` node carries only a predicate;
        # a `while...else` is control flow with no IR node, refused rather than dropped.
        if s.orelse:
            raise SystemExit("lift(py): unsupported while/else (no IR node for the else clause)")
        return {"t": "while", "cond": expr(s.test), "body": [stmt(x) for x in s.body]}
    if isinstance(s, ast.For):
        # A non-range `for x in iter:` is a collection-driven loop (foreach). A
        # single Name target binds `varName`; a tuple/list target (`for k, v in …`)
        # binds `names` (the unpacking item). A for/else clause is control flow with
        # no IR node, so refuse it rather than drop it.
        if s.orelse:
            raise SystemExit("lift(py): unsupported for/else (no IR node for the else clause)")
        out = {"t": "foreach", "iter": expr(s.iter), "body": [stmt(x) for x in s.body]}
        if isinstance(s.target, ast.Name):
            out["varName"] = s.target.id
        else:
            out["names"] = unpack_target_names(s.target)
        return out
    # A `yield value` / `yield from value` / bare `yield` statement (a generator).
    if isinstance(s, ast.Expr) and isinstance(s.value, ast.Yield):
        out = {"t": "yield"}
        if s.value.value is not None:
            out["value"] = expr(s.value.value)
        return out
    if isinstance(s, ast.Expr) and isinstance(s.value, ast.YieldFrom):
        return {"t": "yield", "value": expr(s.value.value), "delegate": True}
    if isinstance(s, ast.Expr) and isinstance(s.value, ast.Call):
        # `print(x)` is the one call with a dedicated effect node; every other call
        # statement (plain, package, or a self/local method call) routes through
        # expr(), which classifies it or refuses loudly.
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
        # A single handler is modelled, optionally TYPED: `except E:` / `except
        # (A, B):` carry their type name(s) on `errorTypes`; a bare `except:` or
        # `except Exception:` stays catch-all. `try/else` and `try/finally` are
        # captured as extra blocks. Several SEPARATE except clauses (distinct types
        # with distinct bodies) have no single-handler IR home — refused, deferred.
        if len(s.handlers) != 1:
            raise SystemExit("lift(py): unsupported try with multiple/zero except handlers (deferred)")
        h = s.handlers[0]
        out = {
            "t": "try",
            "body": [stmt(x) for x in s.body],
            "handler": [stmt(x) for x in h.body],
        }
        # The caught type(s): a bare `except:` or `except Exception:` is catch-all
        # (no errorTypes); a (possibly dotted) name, or a tuple of them, is a typed
        # handler — captured verbatim like a class base / a throw's errorType.
        if h.type is not None and not (isinstance(h.type, ast.Name) and h.type.id == "Exception"):
            if dotted_name(h.type) is not None:
                out["errorTypes"] = [dotted_name(h.type)]
            elif isinstance(h.type, ast.Tuple) and all(dotted_name(e) is not None for e in h.type.elts):
                out["errorTypes"] = [dotted_name(e) for e in h.type.elts]
            else:
                raise SystemExit("lift(py): unsupported except type (only a name, dotted name, or tuple of them)")
        if h.name:
            out["catchParam"] = h.name
        if s.orelse:
            out["orelse"] = [stmt(x) for x in s.orelse]
        if s.finalbody:
            out["finalbody"] = [stmt(x) for x in s.finalbody]
        return out
    if isinstance(s, ast.With):
        # A context-managed block `with ctx as r: body`. Only a single context
        # manager with an optional plain-name `as` binding is modelled; multiple
        # items (`with a, b:`), a tuple/attribute target, or `async with` is a
        # distinct construct refused loudly rather than dropped.
        if len(s.items) != 1:
            raise SystemExit("lift(py): unsupported with multiple context managers (`with a, b:`, deferred)")
        item = s.items[0]
        out = {"t": "with", "context": expr(item.context_expr), "body": [stmt(x) for x in s.body]}
        if item.optional_vars is not None:
            if not isinstance(item.optional_vars, ast.Name):
                raise SystemExit("lift(py): unsupported with-target (only a single `as name`, not unpacking)")
            out["resource"] = item.optional_vars.id
        return out
    if isinstance(s, ast.Pass):
        return {"t": "pass"}
    # A bare `...` (Ellipsis) statement is a no-op placeholder body — common in
    # `@overload` / Protocol stubs (`def get(...) -> _VT: ...`). Model it as `pass`
    # (a no-op, behaviourally identical); it re-emits `pass`, a stable fixed point.
    if isinstance(s, ast.Expr) and isinstance(s.value, ast.Constant) and s.value.value is Ellipsis:
        return {"t": "pass"}
    if isinstance(s, ast.Break):
        return {"t": "break"}
    if isinstance(s, ast.Continue):
        return {"t": "continue"}
    if isinstance(s, ast.Assert):
        # `assert cond` / `assert cond, message` — a control-sequenced effect node.
        out = {"t": "assert", "cond": expr(s.test)}
        if s.msg is not None:
            out["message"] = expr(s.msg)
        return out
    # A nested function/class is a closure capturing the enclosing scope; the IR has
    # only flat, named modules with explicit boundaries — no closure capture — so it
    # is refused loudly (deferred), not silently flattened.
    if isinstance(s, (ast.FunctionDef, ast.AsyncFunctionDef)):
        raise SystemExit("lift(py): unsupported nested function (closure capture has no IR node, deferred)")
    if isinstance(s, ast.ClassDef):
        raise SystemExit("lift(py): unsupported nested class (deferred)")
    # `global x` / `nonlocal x` declare that an assignment targets an ENCLOSING /
    # module scope — cross-scope mutation the IR's per-function dataflow cannot
    # represent (the value would silently rebind a local). Refuse, do not lie.
    if isinstance(s, (ast.Global, ast.Nonlocal)):
        kind = "global" if isinstance(s, ast.Global) else "nonlocal"
        raise SystemExit("lift(py): unsupported " + kind + " declaration (cross-scope mutation has no IR node, deferred)")
    if isinstance(s, ast.Delete):
        # `del obj[key]` / `del obj.attr` are control-sequenced effects. A bare-name
        # delete (`del x`) removes a binding — a scope op with no IR node. Multiple
        # targets (`del a, b`) are refused (rare); a single subscript/attribute is
        # modelled. Both refusals are honest deferrals.
        if len(s.targets) != 1:
            raise SystemExit("lift(py): unsupported multi-target `del` (deferred)")
        t = s.targets[0]
        if isinstance(t, ast.Subscript):
            if isinstance(t.slice, ast.Slice):
                raise SystemExit("lift(py): unsupported slice `del` target (deferred)")
            return {"t": "delIndex", "obj": expr(t.value), "key": expr(t.slice)}
        if isinstance(t, ast.Attribute):
            return {"t": "delAttr", "obj": expr(t.value), "attr": t.attr}
        raise SystemExit("lift(py): unsupported `del` of a bare name (removes a binding — a scope op with no IR node, deferred)")
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


def default_expr(node):
    """A parameter default, restricted to the forms the IR carries (ParamDefault):
    a literal or a bare name reference — the two forms real signatures use almost
    exclusively. A richer default expression refuses loudly rather than lifting to
    a lie (deferred to a later roadmap item)."""
    if isinstance(node, ast.Constant):
        # An `...` (Ellipsis) default is a type-stub placeholder (`x: int = ...`), not
        # a JSON-serializable literal — refuse cleanly rather than crash the extractor.
        if node.value is Ellipsis:
            raise SystemExit("lift(py): unsupported `...` (Ellipsis) default value (type-stub placeholder, deferred)")
        return {"t": "lit", "value": node.value}
    if isinstance(node, ast.Name):
        return {"t": "var", "name": node.id}
    raise SystemExit("lift(py): unsupported default value (only a literal or a bare name is modelled yet)")


def params_of(f, is_method):
    """The full parameter list as neutral-AST params, in declaration order:
    positional-only params (before `/`), then positional(/keyword) params, then
    `*args`, then keyword-only params, then `**kwargs`. Defaults, the `/`/`*`/`**`
    markers, and keyword-/positional-only-ness are captured so the signature
    round-trips."""
    a = f.args
    posonly = list(a.posonlyargs)
    # A method's leading `self` is implicit in the IR; drop it wherever it leads.
    # Defaults align to the TAIL of (posonly + args), so dropping the never-defaulted
    # head keeps them lined up.
    if is_method and (posonly or a.args):
        head = posonly if posonly else a.args
        if head and head[0].arg == "self":
            del head[0]
    normal = a.args
    params = []
    # Defaults fill the tail across posonly+normal combined (Python aligns them so).
    combined = posonly + normal
    first_default = len(combined) - len(a.defaults)
    for i, arg in enumerate(combined):
        p = {"name": arg.arg, "type": map_type(arg.annotation)}
        if i < len(posonly):
            p["positionalOnly"] = True
        if i >= first_default:
            p["default"] = default_expr(a.defaults[i - first_default])
        params.append(p)
    if a.vararg:
        params.append({"name": a.vararg.arg, "type": map_type(a.vararg.annotation), "variadic": "args"})
    # kw_defaults carries one slot per keyword-only arg (None when it has no default).
    for arg, dflt in zip(a.kwonlyargs, a.kw_defaults):
        p = {"name": arg.arg, "type": map_type(arg.annotation), "keywordOnly": True}
        if dflt is not None:
            p["default"] = default_expr(dflt)
        params.append(p)
    if a.kwarg:
        params.append({"name": a.kwarg.arg, "type": map_type(a.kwarg.annotation), "variadic": "kwargs"})
    return params


def decorators_of(node):
    """Decorators captured VERBATIM, outermost first, each as the decorator
    expression sans `@` (`property`, `app.route('/x')`) — opaque metadata the IR
    re-emits, not analysed (cf. base classes). `@staticmethod` / `@classmethod`
    are REFUSED: they drop/rename the implicit receiver, so they change the
    parameter contract rather than just decorate it — a separate concern from
    metadata capture, deferred. Reconstructed via `ast.unparse`, which is
    idempotent on its own output, so the round-trip is a fixed point."""
    out = []
    for d in node.decorator_list:
        if isinstance(d, ast.Name) and d.id in ("staticmethod", "classmethod"):
            raise SystemExit("lift(py): unsupported @" + d.id + " (alters the implicit receiver; not yet modelled)")
        out.append(ast.unparse(d))
    return out


def func(f, is_method=False):
    decorators = decorators_of(f)
    params = params_of(f, is_method)
    returns = [] if is_void(f.returns) else [{"name": "result", "type": map_type(f.returns)}]
    doc, body = docstring_of(f.body)
    out = {"name": f.name, "params": params, "returns": returns, "body": [stmt(x) for x in body]}
    if decorators:
        out["decorators"] = decorators
    if doc is not None:
        out["doc"] = doc
    if is_method:
        out["isMethod"] = True
    if isinstance(f, ast.AsyncFunctionDef):
        out["async"] = True
    sp = span(f)
    if sp is not None:
        out["span"] = sp
    return out


def is_pure(node):
    """True if evaluating `node` has no observable side effect (safe to duplicate).
    Conservative: any call / await / yield / walrus / comprehension makes it impure."""
    for n in ast.walk(node):
        if isinstance(n, (ast.Call, ast.Await, ast.Yield, ast.YieldFrom, ast.NamedExpr,
                          ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)):
            return False
    return True


def dotted_name(node):
    """The dotted identifier of a Name/Attribute chain (`Base`, `abc.ABC`,
    `collections.abc.MutableMapping`), or None for any other expression."""
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        base = dotted_name(node.value)
        if base is not None:
            return base + "." + node.attr
    return None


def klass(c):
    # Positional base classes ARE captured now (roadmap item 5): each is a name or
    # dotted name re-emitted verbatim, like any other type identifier (cf. throw's
    # `errorType`). Class decorators are captured the same way (roadmap item 6).
    # Keyword bases (e.g. `metaclass=`) are real structure the IR does not yet
    # carry; refuse them loudly instead of silently flattening the class.
    if c.keywords:
        raise SystemExit("lift(py): unsupported class keyword base (e.g. metaclass=, not yet in the IR)")
    decorators = decorators_of(c)
    bases = []
    for b in c.bases:
        # A plain/dotted name (`Base`, `abc.ABC`) is captured as-is; a subscripted
        # generic base (`Generic[_VT]`, `MutableMapping[str, _VT]`, `dict[str, _VT]`)
        # is captured VERBATIM via ast.unparse — an opaque type expression the IR
        # re-emits without analysing, exactly like a decorator. ast.unparse is
        # idempotent on its own output, so the base round-trips as a fixed point.
        bases.append(dotted_name(b) or ast.unparse(b))
    fields = []
    methods = []
    doc, body = docstring_of(c.body)
    for n in body:
        if isinstance(n, ast.AnnAssign) and isinstance(n.target, ast.Name):
            fields.append({"name": n.target.id, "type": map_type(n.annotation)})
        elif isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)):
            # `@overload` methods are type-checker-only stubs (bodies are `...`),
            # ERASED at runtime — only the final real implementation runs. Keeping
            # them would create several methods of the same name (a duplicate-id
            # collision). Drop them: the real method carries the behaviour, and the
            # class map stays accurate. (Behaviourally faithful; the type-overload
            # annotations are the only thing lost — types are labels here anyway.)
            decs = decorators_of(n)
            if any(d == "overload" or d.endswith(".overload") for d in decs):
                continue
            methods.append(func(n, is_method=True))
        elif isinstance(n, ast.Pass):
            continue
        else:
            raise SystemExit("lift(py): unsupported class member: " + ast.dump(n))
    out = {"name": c.name, "fields": fields, "methods": methods}
    if bases:
        out["bases"] = bases
    if decorators:
        out["decorators"] = decorators
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


def consts_of(tree):
    """Module-level constant assignments (`HOOKS = ["response"]`, `__all__ = [...]`,
    `X: T = v`). Captured as the bound NAME + the VERBATIM value source (ast.unparse,
    idempotent on its own output → a fixed point), so a function that references the
    constant resolves it (a free identifier) and the constant round-trips at module
    scope. Only a single plain-name target is captured; richer top-level statements
    (an `if`, a tuple target, a bare annotation) are left alone (lifted-what-we-can)."""
    out = []
    for n in tree.body:
        if isinstance(n, ast.Assign) and len(n.targets) == 1 and isinstance(n.targets[0], ast.Name):
            d = {"name": n.targets[0].id, "value": ast.unparse(n.value)}
        elif isinstance(n, ast.AnnAssign) and isinstance(n.target, ast.Name) and n.value is not None:
            d = {"name": n.target.id, "value": ast.unparse(n.value)}
        else:
            continue
        sp = span(n)
        if sp is not None:
            d["span"] = sp
        out.append(d)
    return out


tree = ast.parse(sys.stdin.read())
imports = imports_of(tree)
consts = consts_of(tree)
IMPORTED_NAMES = {b["local"] for imp in imports for b in imp["bindings"]}
MODULE_GLOBALS = {c["name"] for c in consts}
functions = [func(n) for n in tree.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))]
classes = [klass(n) for n in tree.body if isinstance(n, ast.ClassDef)]
print(json.dumps({"functions": functions, "classes": classes, "imports": imports, "consts": consts}))
