# Kontur — Handoff

**Kontur** is a visual-first programming language: a tool for drawing **maps of software**.
Only AI authors code in it. The AI emits a structured graph IR; that IR is the source of
truth. From it, two artifacts are derived: runnable code (multiple language backends) and an
**audit diagram** — the map — that a human reads to understand and trust what the agent built.
Humans never edit the graph.

The name (from *contour* — the lines on a map that reveal hidden terrain) is the thesis: Kontur
surfaces the structure of AI-built software the way a contour map surfaces the shape of land.

This document is the spec + state-of-play for continuing in Claude Code. Two HTML
prototypes accompany it (`prototype-transpile.html`, `prototype-navigator.html`) — they are
throwaway demos, not the codebase. Reproduce the *ideas* properly; don't port the demo code.
(Note: the prototype HTML files still carry the old working name "fluxis" in their UI/code —
ignore it; the project is Kontur.)

---

## 1. Core decisions (locked)

These were settled through design discussion. Treat them as fixed unless you have a strong reason.

- **AI-authored only.** No human editing, no graph→code→graph round-trip, no live sync.
  One direction at a time: AI emits IR → transpile to code; IR → render to diagram.
  This deletes the hardest problem in visual languages (round-trip fidelity). Keep it deleted.
- **Graph IR is canonical (source of truth).** The code and the diagram are both *derived*.
- **Visual is for human audit/trust**, not authoring. The AI never sees pixels. The diagram
  exists so a human can see what the agent built. Correctness + legibility of the rendering
  matter; prettiness is secondary.
- **Language-agnostic IR, multiple backends.** IR node kinds are abstract imperative concepts
  (function / branch / loop / effect / const), mappable to JS, Python, etc. Don't leak
  host-language specifics into the IR.
- **Hybrid control flow** (Unreal Blueprints model): two wire kinds — **data wires** (typed
  values) and **control wires** (execution order, "white exec wire"). Pure dataflow was rejected
  because it can't express conditionals/loops/early-return legibly for a general-purpose language.

## 2. The system model

Two layers, kept distinct:

- **System layer (semantic):** *Features* and *Modules*. Software is dissected into a matrix:
  modules (nestable, the rows) compose into features (the columns / slices).
- **Visual layer (representational):** *Nodes*, *Ports*, *Wires*. How any module is drawn.

Bridge: **a Module IS a Node.** Collapsed, it's one node showing its ports. Expanded, it's a
whole canvas of child nodes + wires. Recursion bottoms out at leaf nodes.

### Features
Features are **not** modeled as nodes, overlays, or a second axis. A feature is simply a
**named top-level canvas** — an entry point / root of the navigation tree. Don't build feature
machinery; a feature is just the module you start navigating from.

### Navigation = hyperlinked canvases (this is the headline idea)
**Never render the whole system at once.** Each canvas shows exactly one module's interior:
its child nodes + the wires between them. A child *module* renders as a single collapsed node
that is a **hyperlink** — clicking it opens that module's interior on a new canvas. Breadcrumbs
climb back. This is "hyperlinks, but for diagrams," forming a hierarchy.

This is the abstraction mechanism that solves the **Deutsch limit** (a screen holds ~50 nodes
before becoming spaghetti). Scale is carried by the *hierarchy*, not the canvas: every canvas
stays small because it's only ever one module deep. Descend to see more; don't zoom.

### The port-boundary invariant (STRICT — load-bearing)
> A module's ports, seen from outside (the collapsed node), must correspond **exactly** to the
> unconnected boundary inside (the expanded canvas): same count, names, types, and data/control kind.

When you descend through a module link, the ports on the collapsed node *are* the boundary
endpoints on the new canvas. Crossing a link cannot change the contract. This is what makes
descent trustworthy — a human knows the collapsed view hides no dependency. A toolchain must
**reject** any graph that violates it.

A module is authored once and may be linked from many canvases (e.g. a shared `UserLookup`).
Every caller must see the identical contract.

## 3. Data model (reference shape, not prescriptive code)

```
System {
  features: ModuleId[]              // entry-point canvases
  modules:  Map<ModuleId, Module>
}

Module {
  title
  ports: Port[]                     // the PUBLIC CONTRACT (in + out)
  interior: {
    nodes: Node[]                   // children
    wires: Wire[]                   // between children and the boundary ports
  }
  // INVARIANT: every Port maps to exactly one boundary endpoint in interior
}

Port { name, type, io: "in"|"out", wire: "data"|"control" }

Node =
  | { kind:"function", label }                 // pure transform, leaf
  | { kind:"branch",   label }                 // conditional, leaf
  | { kind:"loop",     label }                 // iteration, leaf
  | { kind:"effect",   label, io }             // side effect / IO, leaf
  | { kind:"const",    label, value }          // literal, leaf
  | { kind:"module",   ref:ModuleId, ports }   // a nested module = a link
                                               //   ports MUST equal modules[ref].ports

Wire = [from, to, kind:"data"|"control"]
  // endpoints: "nodeId", "nodeId:port", or "P:portName" for the module boundary
```

Note on module-node `ports`: in the navigator demo they are **restated by hand** and checked
after the fact. That's a known wart — see Issue #5. They should be **derived** from
`modules[ref].ports` so drift is structurally impossible.

## 4. What the prototypes show

- `prototype-transpile.html` — one IR (a fizzbuzz: loop + branch + effect + data wires) →
  transpiled to **JavaScript** and **Python** from the same tree, plus a "Run" that executes the
  JS. Demonstrates: IR-as-source-of-truth, multiple backends, hybrid data/control wires drawn
  on a single canvas.
- `prototype-navigator.html` — multi-canvas **hyperlink navigation** across an auth feature and
  a search feature, with breadcrumbs and a live **port-boundary invariant** check on every
  descent. `UserLookup` is shared by two parents with an identical contract. This is the most
  important prototype — it embodies the navigation + invariant model.

Both are hand-laid-out and hard-coded. They prove the model; they are not architecture.

## 5. Open issues / roadmap (the actual work)

Of the original four design problems, **#2 (abstraction/subgraphs) is DONE** — it became the
module-as-node hyperlink model above. Remaining:

**#1 — Automatic graph layout.** The prototypes hand-place nodes in a vertical stack. Any
real AI-emitted IR needs automatic layered-DAG layout (Sugiyama-style). Use **elkjs** or
**dagre** rather than writing your own. This is the one piece of renderer engineering that
gates "render *any* IR" vs. "render this one example." Control wires set primary layer order;
data wires are secondary. Probably the highest-leverage next step for the visualizer.

**#3 — Type system.** Ports carry `type`, but today it's just a label. For multiple backends to
be real the IR must (a) type-check internally — wire endpoints must have compatible types — and
(b) define a type-mapping per backend (IR `int`→JS `number`/Py `int`, etc.). Decide the type
vocabulary: primitives + composites (list, record, union?) + how generics/any are handled.
This is the real weight of "language-agnostic."

**#4 — Effect model.** Currently `effect` nodes are just labels. Decide how side effects are
first-class in the IR: are they ordinary nodes sequenced on the control wire (simpler, Blueprints-
like), or a separated effect system (purer, harder)? This is the bridge between dataflow and
runnable code and the trickiest semantic call. Recommendation given the AI-authored + multi-backend
goals: **effects as control-wire-sequenced nodes** — keeps transpilation to imperative targets
direct. Revisit only if you need effect tracking/purity guarantees.

**#5 — Derived (not restated) contracts.** Make a module node's ports *generated from* the target
module's contract so they can't drift, turning the invariant from "checked after the fact" into
"impossible to express incorrectly." Surfaced while building the navigator.

Suggested order: **#1 (layout)** to make the visualizer general, then **#3 (types)** +
**#4 (effects)** together to make the IR semantically complete, then **#5** as a correctness
hardening pass.

## 6. Suggested architecture for the real build

Three independent components around a single IR (mirrors the three problems that stayed separate):

1. **IR core** — schema, validation (structural + type + invariant), serialization. The "language."
   This is what the AI emits. Define it as a strict schema (zod / JSON Schema / a typed parser)
   so malformed graphs are rejected at the door.
2. **Transpiler** — IR → target source. One pass per backend (JS, Python). Pure function of the IR.
3. **Renderer** — IR → audit diagram. Auto-layout (elk/dagre) → SVG. Stateless per canvas;
   navigation state (breadcrumb stack, current module) lives in the app shell around it.

Keep them decoupled: the transpiler and renderer should each consume the validated IR and share
nothing else. A bad IR should fail in component #1, never in #2 or #3.

Stack suggestion (matches your tooling): TypeScript throughout; the renderer as a React/Canvas or
React/SVG app; **elkjs** for layout; **zod** for IR validation.

## 7. First milestone to aim for

A round-trip of the *real* pipeline on one non-trivial example:
emit a hand-written IR JSON → validate it (structural + invariant + types) → transpile to JS *and*
Python → auto-layout + render the navigable canvas tree. When you can drop in a new IR file and get
both correct code and a correct navigable diagram **with zero hand-placement**, the foundation is real.
