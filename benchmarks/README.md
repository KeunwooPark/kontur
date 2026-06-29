# Kontur benchmarks

A graded synthetic benchmark that measures whether Kontur can correctly **lift**
existing code into the IR, **transpile** it back, and **render** it as an audit
diagram — and what it refuses.

```
npm run bench
```

Outputs land in `benchmarks/out/` (git-ignored):

- `index.html` — gallery: every case with its transpiled code + a link to its diagram.
- `<id>.html` — the rendered, navigable audit diagram for each supported case.
- `REPORT.md` — full scoreboard + per-case notes and transpiled output.
- `<id>.codeA.txt` / `.codeB.txt` — written only when a round-trip is *not* a fixed point, for diffing.

## What it measures

Each case is declared in `manifest.json` with an `expect`:

- **`roundtrip`** (supported subset). Scored on round-trip fidelity — the same
  invariant the unit tests use:

  ```
  source → lift → validate → transpile  = codeA
         → lift(codeA) → transpile       = codeB
  PASS iff codeA === codeB   (a fixed point)
  ```

  Each passing case is also cross-transpiled to the other backend and rendered to HTML.

- **`reject`** (out-of-scope). The lifter must **fail loudly**. PASS iff `lift`
  throws. A lift that *succeeds* here — especially one that yields an empty
  system — is a fail-closed violation and is flagged as a failure.

## Cases

`cases/supported/` — the subset Kontur lifts and round-trips: print effects,
arithmetic + tail return, sequenced stub calls, counted loops, branches,
FizzBuzz, multi-module call graphs (navigation), **classes** (modules-as-methods
+ state-as-attributes), and a second wave of constructs each carried by a small
IR addition:

| construct | how it lifts |
|---|---|
| template strings | a `concat` chain over the string parts (`+` in every backend) |
| while loops | a `while` node — the condition-driven sibling of the counted `loop` |
| ternaries | a `select` node — a pure data multiplexer (Blueprints' Select) |
| branch-arm returns | normalized to a single `return select(cond, a, b)` |
| reassignment (`n += 1`) | an SSA-style rebind, no node — round-trips to `n + 1` inline |
| array literals | an `array` node — a pure list constructor |
| Python comprehensions | a `comprehension` node — range + bound index + element expr |

…all in TypeScript and (where applicable) Python.

`cases/unsupported/` — constructs still outside the IR vocabulary that must be
refused: exception handling (`try`/`catch`), which has no non-local control-flow
form in the IR. This keeps the fail-closed (reject) path exercised.

## Adding a case

1. Drop a `.ts` or `.py` source file under `cases/supported/` or `cases/unsupported/`.
2. Add an entry to `manifest.json` (`id`, `file`, `expect`, `feature`, `title`, `note`).
3. `npm run bench`.

## Classes

A class lifts to a **module of kind `class`** — a namespace canvas whose interior
is one `state` cell per attribute and one `module`-link per method. Each method
is its own function-module (`ClassName.methodName`), reached by descending its
link, exactly like any other module. Inside a method, attributes are accessed
through two node kinds: `stateGet` (a pure data source, `this.x` / `self.x`) and
`stateSet` (a control-sequenced effect, `this.x = …`). See cases `10-class` and
`11-python-class`.
