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
import type { CanvasLayout, LaidOutNode, LaidOutPort, NodeKind } from "./layout.js";

const THEME = {
  edgeControl: "#e7eaf3",
  edgeData: "#5b9cff",
  text: "#e6e9ef",
  textMuted: "#8b93a7",
  portControl: "#e7eaf3",
  portData: "#5b9cff",
};

const KIND_STYLE: Record<Exclude<NodeKind, "boundary">, { fill: string; stroke: string; glyph: string }> = {
  function: { fill: "#16263f", stroke: "#4f8cf0", glyph: "ƒ" },
  branch: { fill: "#3a2a12", stroke: "#e0a13a", glyph: "◆" },
  loop: { fill: "#2a1c3d", stroke: "#a878e8", glyph: "↻" },
  effect: { fill: "#12301f", stroke: "#3fbf7f", glyph: "▮" },
  const: { fill: "#1b1f27", stroke: "#5b6472", glyph: "#" },
  module: { fill: "#0f2e33", stroke: "#36c6d6", glyph: "⧉" },
};

export function renderCanvasSvg(layout: CanvasLayout): string {
  const w = Math.max(layout.width, 1);
  const h = Math.max(layout.height, 1);
  const edges = layout.edges.map(renderEdge).join("");
  const nodes = layout.nodes.map(renderNode).join("");
  return [
    `<svg class="kontur-canvas" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" `,
    `xmlns="http://www.w3.org/2000/svg" font-family="ui-sans-serif,system-ui,sans-serif">`,
    defs(),
    `<g class="edges" fill="none">${edges}</g>`,
    `<g class="nodes">${nodes}</g>`,
    `</svg>`,
  ].join("");
}

function defs(): string {
  return [
    `<defs>`,
    `<marker id="arrow-control" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">`,
    `<path d="M0 0 L10 5 L0 10 z" fill="${THEME.edgeControl}"/></marker>`,
    `<marker id="arrow-data" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">`,
    `<path d="M0 0 L10 5 L0 10 z" fill="${THEME.edgeData}"/></marker>`,
    `</defs>`,
  ].join("");
}

// --- edges ----------------------------------------------------------------

function renderEdge(edge: CanvasLayout["edges"][number]): string {
  const d = pathThrough(edge.points);
  if (edge.wire === "control") {
    return `<path class="wire wire-control" d="${d}" stroke="${THEME.edgeControl}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round" marker-end="url(#arrow-control)"/>`;
  }
  return `<path class="wire wire-data" d="${d}" stroke="${THEME.edgeData}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" marker-end="url(#arrow-data)"/>`;
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

function renderNode(node: LaidOutNode): string {
  if (node.kind === "boundary") return renderBoundary(node);

  const style = KIND_STYLE[node.kind];
  const isLink = node.kind === "module" && node.ref;
  const cx = node.x + node.w / 2;

  const parts: string[] = [];
  const linkAttr = isLink ? ` data-link="${attr(node.ref!)}" role="link" tabindex="0" class="node node-link"` : ` class="node"`;
  parts.push(`<g${linkAttr}>`);

  // body
  parts.push(
    `<rect x="${r(node.x)}" y="${r(node.y)}" width="${r(node.w)}" height="${r(node.h)}" rx="9" ` +
      `fill="${style.fill}" stroke="${style.stroke}" stroke-width="1.5"${isLink ? ` stroke-dasharray="1 0"` : ""}/>`,
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
    `<text x="${r(node.x + 8)}" y="${r(node.y + 15)}" font-size="11" fill="${style.stroke}" opacity="0.85">${esc(style.glyph)}</text>`,
  );

  // label (centred)
  const labelFill = node.kind === "const" ? THEME.text : THEME.text;
  const mono = node.kind === "const" ? ` font-family="ui-monospace,SFMono-Regular,Menlo,monospace"` : "";
  parts.push(
    `<text x="${r(cx)}" y="${r(node.y + node.h / 2 + 4)}" font-size="12" text-anchor="middle" fill="${labelFill}"${mono}>${esc(node.label)}</text>`,
  );
  if (isLink) {
    parts.push(
      `<text x="${r(node.x + node.w - 8)}" y="${r(node.y + 15)}" font-size="11" text-anchor="end" fill="${style.stroke}">↗</text>`,
    );
  }

  // ports
  for (const p of node.ports) parts.push(renderPort(p));

  parts.push(`</g>`);
  return parts.join("");
}

function renderBoundary(node: LaidOutNode): string {
  const stroke = node.ports[0]?.wire === "control" ? THEME.edgeControl : THEME.edgeData;
  const cx = node.x + node.w / 2;
  const label = node.sublabel ? `${node.label}: ${node.sublabel}` : node.label;
  const parts: string[] = [`<g class="node node-boundary">`];
  parts.push(
    `<rect x="${r(node.x)}" y="${r(node.y)}" width="${r(node.w)}" height="${r(node.h)}" rx="${r(node.h / 2)}" ` +
      `fill="#11151c" stroke="${stroke}" stroke-width="1.25"/>`,
  );
  parts.push(
    `<text x="${r(cx)}" y="${r(node.y + node.h / 2 + 4)}" font-size="11" text-anchor="middle" fill="${THEME.text}">${esc(label)}</text>`,
  );
  for (const p of node.ports) parts.push(renderPort(p));
  parts.push(`</g>`);
  return parts.join("");
}

function renderPort(p: LaidOutPort): string {
  const color = p.wire === "control" ? THEME.portControl : THEME.portData;
  const marker =
    p.wire === "control"
      ? // triangle pointing along flow (right)
        `<path d="${triangle(p.x, p.y, 4.5)}" fill="${color}"/>`
      : `<circle cx="${r(p.x)}" cy="${r(p.y)}" r="3.4" fill="${color}"/>`;
  if (!p.name) return marker;

  // label just inside the box edge
  const inside = p.io === "in";
  const lx = inside ? p.x + 8 : p.x - 8;
  const anchor = inside ? "start" : "end";
  const label = `<text x="${r(lx)}" y="${r(p.y + 3)}" font-size="8.5" text-anchor="${anchor}" fill="${THEME.textMuted}">${esc(p.name)}</text>`;
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
