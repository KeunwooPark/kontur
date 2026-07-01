/**
 * Visual themes for the audit map.
 *
 * A theme is a flat palette: every colour the diagram (svg.ts) and the viewer
 * shell (html.ts) draw with comes from here, so the look is swappable without
 * touching the rendering logic. Structure (glyphs, geometry, stroke widths)
 * stays in the renderers — a theme only recolours.
 *
 * The default is `paper`: a white background with a muted, academic palette,
 * the way a figure reads in a printed paper. `ink` keeps the original dark
 * console look for anyone who prefers it.
 */
import type { NodeKind } from "./layout.js";

/** The node kinds that have a styled body (everything but the boundary pill). */
export type StyledKind = Exclude<NodeKind, "boundary">;

/**
 * Ordered kind metadata shared by the renderer and the legend: the glyph and
 * human name are structural (they identify the kind), so they live with the
 * kind list rather than in any one theme.
 */
export const KINDS: { kind: StyledKind; glyph: string; label: string }[] = [
  { kind: "function", glyph: "ƒ", label: "function" },
  { kind: "method", glyph: "⟜", label: "method call" },
  { kind: "branch", glyph: "◆", label: "branch" },
  { kind: "merge", glyph: "◇", label: "merge — branch join / φ" },
  { kind: "loop", glyph: "↻", label: "loop" },
  { kind: "while", glyph: "⟲", label: "while loop" },
  { kind: "foreach", glyph: "∈", label: "for-each loop" },
  { kind: "try", glyph: "⛨", label: "try — protected block" },
  { kind: "with", glyph: "⊏⊐", label: "with — context-managed block" },
  { kind: "assert", glyph: "‼", label: "assert" },
  { kind: "throw", glyph: "↯", label: "throw — raise / escape" },
  { kind: "rethrow", glyph: "⤴", label: "rethrow — re-raise a value" },
  { kind: "break", glyph: "⤓", label: "break — exit loop" },
  { kind: "continue", glyph: "↺", label: "continue — next iteration" },
  { kind: "return", glyph: "⏎", label: "return — function exit" },
  { kind: "yield", glyph: "⤳", label: "yield — generator output" },
  { kind: "await", glyph: "⌛", label: "await — resolve awaitable" },
  { kind: "globalRef", glyph: "𝑔", label: "global — module constant" },
  { kind: "selfRef", glyph: "◈", label: "self — ambient receiver value" },
  { kind: "effect", glyph: "▮", label: "effect" },
  { kind: "const", glyph: "#", label: "const" },
  { kind: "select", glyph: "⋔", label: "select — value conditional" },
  { kind: "array", glyph: "▦", label: "list literal" },
  { kind: "collection", glyph: "⊞", label: "collection literal" },
  { kind: "comprehension", glyph: "∀", label: "comprehension" },
  { kind: "itercomp", glyph: "∋", label: "iterable comprehension" },
  { kind: "index", glyph: "⊏", label: "index — subscript read" },
  { kind: "slice", glyph: "⊆", label: "slice" },
  { kind: "module", glyph: "⧉", label: "module" },
  { kind: "state", glyph: "▣", label: "state — attribute" },
  { kind: "stateGet", glyph: "↥", label: "read attribute" },
  { kind: "stateSet", glyph: "↧", label: "write attribute" },
  { kind: "attrGet", glyph: "↦", label: "read member" },
  { kind: "attrSet", glyph: "↤", label: "write member" },
  { kind: "indexSet", glyph: "⊐", label: "index write — subscript assign" },
  { kind: "delIndex", glyph: "⊘", label: "del — delete element" },
  { kind: "delAttr", glyph: "⊗", label: "del — delete attribute" },
  { kind: "unpack", glyph: "⇶", label: "unpack — destructuring bind" },
  { kind: "broadcast", glyph: "⇉", label: "broadcast — chained assignment" },
];

export interface Theme {
  /** Stable identifier, e.g. "paper". */
  name: string;

  // --- viewer chrome + canvas surfaces ------------------------------------
  /** App / canvas background. */
  bg: string;
  /** Sidebar, breadcrumb bar, and boundary-pill surface. */
  panel: string;
  /** Borders and dividers. */
  line: string;
  /** Primary text (node labels, body copy). */
  text: string;
  /** Secondary text (port labels, captions). */
  textMuted: string;
  /** Hover background for interactive chrome. */
  surfaceHover: string;
  /** Accent for active / link affordances. */
  accent: string;
  /** Soft accent fill behind the active feature. */
  accentSoft: string;
  /** Text colour that sits on `accentSoft`. */
  accentText: string;

  // --- wires ---------------------------------------------------------------
  /** Control "spine" — execution order (bold). */
  edgeControl: string;
  /** Data wire — values (thin). */
  edgeData: string;

  // --- node bodies, per kind ----------------------------------------------
  kinds: Record<StyledKind, { fill: string; stroke: string }>;

  /**
   * A call that crosses out of the authored code into an imported package
   * (a `function` node carrying `source`). It is NOT a node kind — any function
   * node can be external — so it gets its own swatch rather than a `kinds` entry.
   * Drawn dashed (a boundary you cannot descend through) in a deliberately
   * off-palette neutral, so a third-party dependency reads as "not your code".
   */
  external: { fill: string; stroke: string };
}

/**
 * The marker glyph for an external (package) call, shared by the node body and
 * the legend. Distinct from the `ƒ` of a local call — reads as "brought in".
 */
export const EXTERNAL_GLYPH = "⤓";

/**
 * Default: white background with the Okabe–Ito qualitative palette — the
 * colourblind-safe categorical set used in scientific figures. Each node kind
 * gets its own hue (saturated stroke + a pale tint of it for the fill) so the
 * six categories stay distinguishable at a glance and in greyscale print.
 */
export const paper: Theme = {
  name: "paper",
  bg: "#ffffff",
  panel: "#f6f7f9",
  line: "#d7dbe0",
  text: "#1a1f29",
  textMuted: "#57606e",
  surfaceHover: "#eef1f5",
  accent: "#0072b2", // Okabe–Ito blue
  accentSoft: "#e1eef7",
  accentText: "#084c79",
  edgeControl: "#2b2f3a", // ink spine — bold execution order
  edgeData: "#0072b2", // blue — values
  kinds: {
    function: { fill: "#e4eff7", stroke: "#0072b2" }, // blue
    method: { fill: "#e4eff7", stroke: "#0072b2" }, // blue — a call, like function
    branch: { fill: "#fbf1da", stroke: "#e69f00" }, // amber
    merge: { fill: "#f5ecd6", stroke: "#b07d10" }, // deeper amber — the branch join (φ)
    loop: { fill: "#f7e7f0", stroke: "#cc79a7" }, // reddish purple
    while: { fill: "#e3f1fb", stroke: "#56b4e9" }, // sky blue — the other loop
    foreach: { fill: "#eef6e2", stroke: "#5a9216" }, // olive green — the collection loop
    try: { fill: "#f7ddd9", stroke: "#b23a2e" }, // brick red — protected/recovery
    with: { fill: "#f7e6da", stroke: "#b2682e" }, // warm brown — context-managed block (try-adjacent)
    assert: { fill: "#fbe7d9", stroke: "#c17a12" }, // ochre — a guard/check effect
    throw: { fill: "#fbd9de", stroke: "#c1121f" }, // crimson — the raise/escape sibling of try
    rethrow: { fill: "#fbe3e0", stroke: "#a01a2e" }, // deep crimson — re-raise an existing value
    break: { fill: "#f7eef0", stroke: "#a05a72" }, // muted plum — loop escape (loop-adjacent)
    continue: { fill: "#f7eef0", stroke: "#a05a72" }, // muted plum — loop escape
    return: { fill: "#e9ecf2", stroke: "#3a4252" }, // ink grey — the function exit (spine end)
    yield: { fill: "#eaf3e8", stroke: "#3f8a4a" }, // green — generator output (stream)
    await: { fill: "#e4eff7", stroke: "#0072b2" }, // blue — a call-like value transform
    globalRef: { fill: "#eef0f2", stroke: "#6b7280" }, // neutral grey — a constant reference
    selfRef: { fill: "#e6e7fb", stroke: "#4b4fc4" }, // state-family indigo — the receiver as a value
    effect: { fill: "#dcf1ea", stroke: "#009e73" }, // bluish green
    const: { fill: "#eef0f2", stroke: "#6b7280" }, // neutral grey
    select: { fill: "#f6ead0", stroke: "#a86b00" }, // deep amber — a data conditional
    module: { fill: "#fce8dd", stroke: "#d55e00" }, // vermillion
    // collection family — one shared teal hue for list-valued producers.
    array: { fill: "#daf0f3", stroke: "#0a7d8c" },
    collection: { fill: "#daf0f3", stroke: "#0a7d8c" },
    comprehension: { fill: "#daf0f3", stroke: "#0a7d8c" },
    itercomp: { fill: "#daf0f3", stroke: "#0a7d8c" },
    // subscript/slice read off a collection — share the collection teal.
    index: { fill: "#daf0f3", stroke: "#0a7d8c" },
    slice: { fill: "#daf0f3", stroke: "#0a7d8c" },
    // a subscript write shares the collection teal (it writes into a collection).
    indexSet: { fill: "#daf0f3", stroke: "#0a7d8c" },
    // deletes touch a collection/receiver — share the collection teal.
    delIndex: { fill: "#daf0f3", stroke: "#0a7d8c" },
    delAttr: { fill: "#daf0f3", stroke: "#0a7d8c" },
    // unpack destructures a sequence value — share the collection teal.
    unpack: { fill: "#daf0f3", stroke: "#0a7d8c" },
    broadcast: { fill: "#daf0f3", stroke: "#0a7d8c" },
    // state family — one shared indigo hue so attributes + their accessors read
    // as a group, distinct from the flow kinds above.
    state: { fill: "#e6e7fb", stroke: "#4b4fc4" },
    stateGet: { fill: "#eceefc", stroke: "#5a67d8" },
    stateSet: { fill: "#eceefc", stroke: "#5a67d8" },
    // member read/write share the state-accessor indigo (they touch a receiver).
    attrGet: { fill: "#eceefc", stroke: "#5a67d8" },
    attrSet: { fill: "#eceefc", stroke: "#5a67d8" },
  },
  external: { fill: "#f0ece6", stroke: "#8a6d4f" }, // taupe — off-palette "not your code"
};

/** The original dark console palette. */
export const ink: Theme = {
  name: "ink",
  bg: "#0e1116",
  panel: "#11151c",
  line: "#222936",
  text: "#e6e9ef",
  textMuted: "#8b93a7",
  surfaceHover: "#161b24",
  accent: "#36c6d6",
  accentSoft: "#0f2e33",
  accentText: "#bff0f6",
  edgeControl: "#e7eaf3",
  edgeData: "#5b9cff",
  kinds: {
    function: { fill: "#16263f", stroke: "#4f8cf0" },
    method: { fill: "#16263f", stroke: "#4f8cf0" }, // a call, like function
    branch: { fill: "#3a2a12", stroke: "#e0a13a" },
    merge: { fill: "#33260f", stroke: "#c99433" }, // deeper amber — the branch join (φ)
    loop: { fill: "#2a1c3d", stroke: "#a878e8" },
    while: { fill: "#13283a", stroke: "#56b4e9" },
    foreach: { fill: "#1c2f12", stroke: "#7fb84a" },
    try: { fill: "#3a1714", stroke: "#e0584a" },
    with: { fill: "#3a2814", stroke: "#e0904a" },
    assert: { fill: "#3a2810", stroke: "#d0973a" },
    throw: { fill: "#3a1218", stroke: "#f0556a" },
    rethrow: { fill: "#3a141c", stroke: "#f07a88" },
    break: { fill: "#2e1c26", stroke: "#c07a98" },
    continue: { fill: "#2e1c26", stroke: "#c07a98" },
    return: { fill: "#1e2430", stroke: "#8a96ac" },
    yield: { fill: "#16291a", stroke: "#5aa564" },
    await: { fill: "#16263f", stroke: "#4f8cf0" },
    globalRef: { fill: "#1b1f27", stroke: "#5b6472" },
    selfRef: { fill: "#1e1f3a", stroke: "#6b6fd0" },
    effect: { fill: "#12301f", stroke: "#3fbf7f" },
    const: { fill: "#1b1f27", stroke: "#5b6472" },
    select: { fill: "#33270f", stroke: "#d09a3a" },
    module: { fill: "#0f2e33", stroke: "#36c6d6" },
    array: { fill: "#10303a", stroke: "#2bb5c9" },
    collection: { fill: "#10303a", stroke: "#2bb5c9" },
    comprehension: { fill: "#10303a", stroke: "#2bb5c9" },
    itercomp: { fill: "#10303a", stroke: "#2bb5c9" },
    index: { fill: "#10303a", stroke: "#2bb5c9" },
    slice: { fill: "#10303a", stroke: "#2bb5c9" },
    indexSet: { fill: "#10303a", stroke: "#2bb5c9" }, // subscript write — collection teal
    delIndex: { fill: "#10303a", stroke: "#2bb5c9" },
    delAttr: { fill: "#10303a", stroke: "#2bb5c9" },
    unpack: { fill: "#10303a", stroke: "#2bb5c9" }, // destructuring bind — collection teal
    broadcast: { fill: "#10303a", stroke: "#2bb5c9" },
    state: { fill: "#1e1f3a", stroke: "#8b8ff0" },
    stateGet: { fill: "#191b30", stroke: "#7c83e8" },
    stateSet: { fill: "#191b30", stroke: "#7c83e8" },
    attrGet: { fill: "#191b30", stroke: "#7c83e8" }, // member read — state-accessor indigo
    attrSet: { fill: "#191b30", stroke: "#7c83e8" }, // member write — state-accessor indigo
  },
  external: { fill: "#241f17", stroke: "#b08d63" }, // muted amber-brown — "not your code"
};

/** All built-in themes, keyed by name. */
export const themes: Record<string, Theme> = { paper, ink };

/** The theme used when none is specified. */
export const defaultTheme: Theme = paper;
