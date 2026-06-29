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
  { kind: "branch", glyph: "◆", label: "branch" },
  { kind: "loop", glyph: "↻", label: "loop" },
  { kind: "while", glyph: "⟲", label: "while loop" },
  { kind: "effect", glyph: "▮", label: "effect" },
  { kind: "const", glyph: "#", label: "const" },
  { kind: "select", glyph: "⋔", label: "select — value conditional" },
  { kind: "array", glyph: "▦", label: "list literal" },
  { kind: "comprehension", glyph: "∀", label: "comprehension" },
  { kind: "module", glyph: "⧉", label: "module" },
  { kind: "state", glyph: "▣", label: "state — attribute" },
  { kind: "stateGet", glyph: "↥", label: "read attribute" },
  { kind: "stateSet", glyph: "↧", label: "write attribute" },
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
}

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
    branch: { fill: "#fbf1da", stroke: "#e69f00" }, // amber
    loop: { fill: "#f7e7f0", stroke: "#cc79a7" }, // reddish purple
    while: { fill: "#e3f1fb", stroke: "#56b4e9" }, // sky blue — the other loop
    effect: { fill: "#dcf1ea", stroke: "#009e73" }, // bluish green
    const: { fill: "#eef0f2", stroke: "#6b7280" }, // neutral grey
    select: { fill: "#f6ead0", stroke: "#a86b00" }, // deep amber — a data conditional
    module: { fill: "#fce8dd", stroke: "#d55e00" }, // vermillion
    // collection family — one shared teal hue for list-valued producers.
    array: { fill: "#daf0f3", stroke: "#0a7d8c" },
    comprehension: { fill: "#daf0f3", stroke: "#0a7d8c" },
    // state family — one shared indigo hue so attributes + their accessors read
    // as a group, distinct from the flow kinds above.
    state: { fill: "#e6e7fb", stroke: "#4b4fc4" },
    stateGet: { fill: "#eceefc", stroke: "#5a67d8" },
    stateSet: { fill: "#eceefc", stroke: "#5a67d8" },
  },
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
    branch: { fill: "#3a2a12", stroke: "#e0a13a" },
    loop: { fill: "#2a1c3d", stroke: "#a878e8" },
    while: { fill: "#13283a", stroke: "#56b4e9" },
    effect: { fill: "#12301f", stroke: "#3fbf7f" },
    const: { fill: "#1b1f27", stroke: "#5b6472" },
    select: { fill: "#33270f", stroke: "#d09a3a" },
    module: { fill: "#0f2e33", stroke: "#36c6d6" },
    array: { fill: "#10303a", stroke: "#2bb5c9" },
    comprehension: { fill: "#10303a", stroke: "#2bb5c9" },
    state: { fill: "#1e1f3a", stroke: "#8b8ff0" },
    stateGet: { fill: "#191b30", stroke: "#7c83e8" },
    stateSet: { fill: "#191b30", stroke: "#7c83e8" },
  },
};

/** All built-in themes, keyed by name. */
export const themes: Record<string, Theme> = { paper, ink };

/** The theme used when none is specified. */
export const defaultTheme: Theme = paper;
