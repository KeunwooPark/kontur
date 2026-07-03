/**
 * Render one laid-out canvas to an SVG string.
 *
 * The diagram is an audit artifact: a human reads it to trust what the agent
 * built. So the two wire kinds must be *unmistakable* — the control "spine" is
 * drawn bold and light (the execution order), data wires thin and blue (values)
 * — and every node's kind is legible at a glance. Prettiness is secondary to
 * that legibility (manifesto §1).
 *
 * Module nodes carry `data-link` so the app shell can turn them into
 * hyperlinks; this function knows nothing about navigation.
 */
import type { CanvasLayout, LaidOutNode, LaidOutPort } from "./layout.js";
import { defaultTheme, EXTERNAL_GLYPH, KINDS, type StyledKind, type Theme } from "./theme.js";

/** Per-kind glyph — structural (the node's identity), so it is not themed. */
const GLYPH = Object.fromEntries(KINDS.map((k) => [k.kind, k.glyph])) as Record<StyledKind, string>;

/**
 * A "knockout" halo: paint the text's own outline in the local background
 * colour first (paint-order=stroke), so the glyphs stay legible wherever a wire
 * happens to pass beneath them. This is the overlap guard for labels that sit
 * over the canvas rather than inside a filled node body.
 */
function halo(bg: string): string {
  return ` paint-order="stroke" stroke="${bg}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"`;
}

export function renderCanvasSvg(layout: CanvasLayout, theme: Theme = defaultTheme): string {
  const w = Math.max(layout.width, 1);
  const h = Math.max(layout.height, 1);
  const edges = layout.edges.map((e) => renderEdge(e, theme)).join("");
  const nodes = layout.nodes.map((n) => renderNode(n, theme)).join("");
  return [
    `<svg class="kontur-canvas" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" `,
    `xmlns="http://www.w3.org/2000/svg" font-family="ui-sans-serif,system-ui,sans-serif">`,
    defs(theme),
    `<g class="edges" fill="none">${edges}</g>`,
    `<g class="nodes">${nodes}</g>`,
    `</svg>`,
  ].join("");
}

function defs(theme: Theme): string {
  return [
    `<defs>`,
    `<marker id="arrow-control" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">`,
    `<path d="M0 0 L10 5 L0 10 z" fill="${theme.edgeControl}"/></marker>`,
    `<marker id="arrow-data" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">`,
    `<path d="M0 0 L10 5 L0 10 z" fill="${theme.edgeData}"/></marker>`,
    `</defs>`,
  ].join("");
}

// --- edges ----------------------------------------------------------------

function renderEdge(edge: CanvasLayout["edges"][number], theme: Theme): string {
  const d = pathThrough(edge.points);
  if (edge.wire === "control") {
    return `<path class="wire wire-control" d="${d}" stroke="${theme.edgeControl}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round" marker-end="url(#arrow-control)"/>`;
  }
  return `<path class="wire wire-data" d="${d}" stroke="${theme.edgeData}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" marker-end="url(#arrow-data)"/>`;
}

/** Polyline with lightly rounded corners for readability. */
function pathThrough(pts: { x: number; y: number }[]): string {
  if (pts.length === 0) return "";
  if (pts.length <= 2) return pts.map((p, i) => `${i ? "L" : "M"}${r(p.x)} ${r(p.y)}`).join(" ");
  const R = 6;
  let d = `M${r(pts[0]!.x)} ${r(pts[0]!.y)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = pts[i - 1]!;
    const cur = pts[i]!;
    const next = pts[i + 1]!;
    const p1 = approach(cur, prev, R);
    const p2 = approach(cur, next, R);
    d += ` L${r(p1.x)} ${r(p1.y)} Q${r(cur.x)} ${r(cur.y)} ${r(p2.x)} ${r(p2.y)}`;
  }
  const last = pts[pts.length - 1]!;
  d += ` L${r(last.x)} ${r(last.y)}`;
  return d;
}

/** A point `dist` away from `corner` toward `toward` (clamped to the segment). */
function approach(corner: { x: number; y: number }, toward: { x: number; y: number }, dist: number) {
  const dx = toward.x - corner.x;
  const dy = toward.y - corner.y;
  const len = Math.hypot(dx, dy) || 1;
  const t = Math.min(dist, len / 2) / len;
  return { x: corner.x + dx * t, y: corner.y + dy * t };
}

// --- nodes ----------------------------------------------------------------

function renderNode(node: LaidOutNode, theme: Theme): string {
  if (node.kind === "boundary") return renderBoundary(node, theme);

  // An external (package) call is any function node carrying `source`. It is a
  // boundary you can SEE but not descend through — so it is drawn dashed, in the
  // off-palette `external` swatch, with the package named on a sub-line. This is
  // the audit signal: every crossing into third-party code is visibly marked.
  const isExternal = node.source !== undefined;
  // A `module` node is always a link; a `method` node is a link only when the
  // lifter resolved its receiver's class (carrying a `ref` to the method's module).
  const isLink = (node.kind === "module" || node.kind === "method") && node.ref;
  const style = isExternal ? theme.external : theme.kinds[node.kind];
  const glyph = isExternal ? EXTERNAL_GLYPH : GLYPH[node.kind];
  const cx = node.x + node.w / 2;

  const parts: string[] = [];
  const cls = isExternal ? ` class="node node-external"` : isLink ? ` class="node node-link"` : ` class="node"`;
  const linkAttr = isLink ? ` data-link="${attr(node.ref!)}" role="link" tabindex="0"` : "";
  const srcAttr = isExternal ? ` data-source="${attr(node.source!)}"` : "";
  parts.push(`<g${cls}${linkAttr}${srcAttr}>`);

  // body
  parts.push(
    `<rect x="${r(node.x)}" y="${r(node.y)}" width="${r(node.w)}" height="${r(node.h)}" rx="9" ` +
      `fill="${style.fill}" stroke="${style.stroke}" stroke-width="1.5"${isExternal ? ` stroke-dasharray="4 3"` : ""}/>`,
  );
  if (isLink) {
    // a second inset border to read as "opens another canvas"
    parts.push(
      `<rect x="${r(node.x + 3)}" y="${r(node.y + 3)}" width="${r(node.w - 6)}" height="${r(node.h - 6)}" rx="6" ` +
        `fill="none" stroke="${style.stroke}" stroke-width="0.75" opacity="0.5"/>`,
    );
  }

  // kind glyph (top-left)
  parts.push(
    `<text x="${r(node.x + 8)}" y="${r(node.y + 15)}" font-size="11" fill="${style.stroke}" opacity="0.85">${esc(glyph)}</text>`,
  );

  // label — centred, nudged up when a package sub-line shares the box
  const labelFill = theme.text;
  const mono = node.kind === "const" ? ` font-family="ui-monospace,SFMono-Regular,Menlo,monospace"` : "";
  const labelY = isExternal ? node.y + node.h / 2 - 2 : node.y + node.h / 2 + 4;
  parts.push(
    `<text x="${r(cx)}" y="${r(labelY)}" font-size="12" text-anchor="middle" fill="${labelFill}"${halo(style.fill)}${mono}>${esc(node.label)}</text>`,
  );
  if (isExternal) {
    // the package name, small and in the swatch hue — "this comes from here"
    parts.push(
      `<text x="${r(cx)}" y="${r(node.y + node.h / 2 + 12)}" font-size="9" text-anchor="middle" fill="${style.stroke}"${halo(style.fill)}>${esc(node.source!)}</text>`,
    );
  }
  if (isLink) {
    parts.push(
      `<text x="${r(node.x + node.w - 8)}" y="${r(node.y + 15)}" font-size="11" text-anchor="end" fill="${style.stroke}">↗</text>`,
    );
  }

  // ports
  for (const p of node.ports) parts.push(renderPort(p, theme, style.fill));

  parts.push(`</g>`);
  return parts.join("");
}

function renderBoundary(node: LaidOutNode, theme: Theme): string {
  const stroke = node.ports[0]?.wire === "control" ? theme.edgeControl : theme.edgeData;
  const cx = node.x + node.w / 2;
  const label = node.sublabel ? `${node.label}: ${node.sublabel}` : node.label;
  const parts: string[] = [`<g class="node node-boundary">`];
  parts.push(
    `<rect x="${r(node.x)}" y="${r(node.y)}" width="${r(node.w)}" height="${r(node.h)}" rx="${r(node.h / 2)}" ` +
      `fill="${theme.panel}" stroke="${stroke}" stroke-width="1.25"/>`,
  );
  parts.push(
    `<text x="${r(cx)}" y="${r(node.y + node.h / 2 + 4)}" font-size="11" text-anchor="middle" fill="${theme.text}"${halo(theme.panel)}>${esc(label)}</text>`,
  );
  // marker only — the centred label already names this port, and a per-port
  // label here would land in the wire channel and collide with the wires.
  for (const p of node.ports) parts.push(renderPort(p, theme, theme.panel, false));
  parts.push(`</g>`);
  return parts.join("");
}

function renderPort(p: LaidOutPort, theme: Theme, bg: string, labeled = true): string {
  const color = p.wire === "control" ? theme.edgeControl : theme.edgeData;
  const marker =
    p.wire === "control"
      ? // triangle pointing along flow (right)
        `<path d="${triangle(p.x, p.y, 4.5)}" fill="${color}"/>`
      : `<circle cx="${r(p.x)}" cy="${r(p.y)}" r="3.4" fill="${color}"/>`;
  if (!p.name || !labeled) return marker;

  // label just inside the box edge, knocked out against the node body
  const inside = p.io === "in";
  const lx = inside ? p.x + 8 : p.x - 8;
  const anchor = inside ? "start" : "end";
  const label = `<text x="${r(lx)}" y="${r(p.y + 3)}" font-size="8.5" text-anchor="${anchor}" fill="${theme.textMuted}"${halo(bg)}>${esc(p.name)}</text>`;
  return marker + label;
}

function triangle(x: number, y: number, s: number): string {
  return `M${r(x - s)} ${r(y - s)} L${r(x + s)} ${r(y)} L${r(x - s)} ${r(y + s)} z`;
}

// --- helpers --------------------------------------------------------------

function r(n: number): number {
  return Math.round(n * 100) / 100;
}

function esc(s: string): string {
  return s.replace(/[<>&]/g, (c) => (c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;"));
}

function attr(s: string): string {
  return s.replace(/[<>&"]/g, (c) => (c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === "&" ? "&amp;" : "&quot;"));
}
