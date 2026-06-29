/**
 * Kontur renderer — public surface. Validated IR → audit diagram.
 *
 * Component #3 of the architecture (manifesto §6): consumes a validated System
 * and shares nothing with the transpiler. Auto-layout (elkjs) per module →
 * SVG per canvas → one navigable, self-contained HTML document.
 */
import type { System } from "../ir/schema.js";
import { layoutModule, type CanvasLayout } from "./layout.js";
import { renderCanvasSvg } from "./svg.js";
import { renderHtml, type Canvas } from "./html.js";

export { layoutModule, renderCanvasSvg, renderHtml };
export type { CanvasLayout, LaidOutNode, LaidOutPort, LaidOutEdge, NodeKind } from "./layout.js";
export type { Canvas } from "./html.js";

/** Lay out every module of the system (one canvas each). */
export async function layoutSystem(system: System): Promise<CanvasLayout[]> {
  return Promise.all(Object.keys(system.modules).map((id) => layoutModule(id, system)));
}

/** Validated System → a single self-contained, navigable HTML document. */
export async function render(system: System): Promise<string> {
  const layouts = await layoutSystem(system);
  const canvases: Canvas[] = layouts.map((l) => ({
    moduleId: l.moduleId,
    title: l.title,
    svg: renderCanvasSvg(l),
  }));
  return renderHtml(system, canvases);
}
