/**
 * The app shell: a single self-contained HTML document that makes the canvases
 * navigable (manifesto §2 — "hyperlinks, but for diagrams").
 *
 * Each module is one hidden canvas; exactly one is shown at a time. A module
 * node carries `data-link` (from svg.ts) — clicking it descends into that
 * module's interior on a fresh canvas and pushes a breadcrumb. Breadcrumbs climb
 * back. The renderer stays stateless per canvas; this navigation state (the
 * breadcrumb stack, the current module) lives here, in the shell around it.
 *
 * No framework, no build step: vanilla JS, opens straight in a browser.
 */
import type { Import, System } from "../ir/schema.js";
import { defaultTheme, EXTERNAL_GLYPH, KINDS, type Theme } from "./theme.js";

export interface Canvas {
  moduleId: string;
  title: string;
  svg: string;
}

export function renderHtml(system: System, canvases: Canvas[], theme: Theme = defaultTheme): string {
  const titles: Record<string, string> = {};
  for (const c of canvases) titles[c.moduleId] = c.title;

  const features = system.features.filter((f) => f in system.modules);
  const featureList = features
    .map(
      (id) =>
        `<button class="feature" data-module="${attr(id)}">${esc(titles[id] ?? id)}</button>`,
    )
    .join("");

  const stage = canvases
    .map(
      (c) =>
        `<section class="canvas" data-module="${attr(c.moduleId)}"><div class="canvas-scroll">${c.svg}</div></section>`,
    )
    .join("");

  const kindLegend = KINDS.map((k) => {
    const s = theme.kinds[k.kind];
    const note = k.kind === "module" ? " — click to descend" : "";
    return (
      `<div class="legend-row"><span class="kind-chip" style="background:${attr(s.fill)};border-color:${attr(s.stroke)};color:${attr(s.stroke)}">${esc(k.glyph)}</span>${esc(k.label)}${note}</div>`
    );
  }).join("");

  // The external-call swatch is appended to the node legend: it is not a node
  // kind (any function may be external), so it sits apart, drawn dashed.
  const ext = theme.external;
  const externalLegend =
    `<div class="legend-row"><span class="kind-chip dashed" style="background:${attr(ext.fill)};border-color:${attr(ext.stroke)};color:${attr(ext.stroke)}">${esc(EXTERNAL_GLYPH)}</span>external — package call</div>`;

  // Dependencies surface: the system's imports listed verbatim. This is the
  // supply-chain view — every package the agent pulled in, at a glance.
  const imports = system.imports ?? [];
  const depList = imports.length
    ? imports
        .map(
          (imp) =>
            `<div class="dep"><span class="dep-src">${esc(imp.source)}</span><span class="dep-bind">${esc(bindingSummary(imp))}</span></div>`,
        )
        .join("")
    : '<div class="empty">none</div>';

  const bootData = JSON.stringify({ titles, features });

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Kontur — ${esc(systemTitle(system, titles))}</title>
<style>${css(theme)}</style>
</head>
<body>
<aside class="sidebar">
  <div class="brand">Kontur</div>
  <div class="brand-sub">audit map</div>
  <div class="section-label">Features</div>
  <nav class="features">${featureList || '<div class="empty">no features</div>'}</nav>
  <div class="section-label">Dependencies</div>
  <div class="deps">${depList}</div>
  <div class="legend">
    <div class="section-label">Wires</div>
    <div class="legend-row"><span class="swatch control"></span>control — execution order</div>
    <div class="legend-row"><span class="swatch data"></span>data — values</div>
    <div class="section-label">Nodes</div>
    ${kindLegend}
    ${externalLegend}
  </div>
</aside>
<main class="main">
  <nav class="breadcrumbs" id="breadcrumbs"></nav>
  <div class="stage">${stage}</div>
</main>
<script id="kontur-data" type="application/json">${bootData}</script>
<script>${SCRIPT}</script>
</body>
</html>`;
}

function systemTitle(system: System, titles: Record<string, string>): string {
  const first = system.features.find((f) => f in system.modules);
  return first ? (titles[first] ?? first) : "system";
}

/** One-line summary of what an import binds (for the Dependencies list). */
function bindingSummary(imp: Import): string {
  if (imp.bindings.length === 0) return "(side-effect)";
  return imp.bindings
    .map((b) => {
      if (b.kind === "namespace") return `∗ ${b.local}`;
      if (b.kind === "default") return `${b.local} (default)`;
      return b.imported === b.local ? b.local : `${b.imported}→${b.local}`;
    })
    .join(", ");
}

/** Build the viewer stylesheet from a theme. */
function css(t: Theme): string {
  return `
:root{--bg:${t.bg};--panel:${t.panel};--line:${t.line};--text:${t.text};--muted:${t.textMuted};--accent:${t.accent};--accent-soft:${t.accentSoft};--accent-text:${t.accentText};--hover:${t.surfaceHover};--control:${t.edgeControl};--data:${t.edgeData};}
*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{display:flex;background:var(--bg);color:var(--text);font:14px/1.4 ui-sans-serif,system-ui,-apple-system,sans-serif}
.sidebar{width:240px;flex:0 0 240px;border-right:1px solid var(--line);padding:18px 16px;overflow:auto;background:var(--panel)}
.brand{font-weight:650;font-size:18px;letter-spacing:.02em}
.brand-sub{color:var(--muted);font-size:12px;margin-bottom:20px}
.section-label{text-transform:uppercase;letter-spacing:.08em;font-size:11px;color:var(--muted);margin:18px 0 8px}
.features{display:flex;flex-direction:column;gap:4px}
.feature{display:block;width:100%;text-align:left;background:transparent;border:1px solid transparent;color:var(--text);padding:7px 10px;border-radius:7px;cursor:pointer;font:inherit}
.feature:hover{background:var(--hover)}
.feature.current{background:var(--accent-soft);border-color:var(--accent);color:var(--accent-text)}
.empty{color:var(--muted);font-size:13px}
.legend{margin-top:8px}
.legend-row{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:12px;margin:6px 0}
.swatch{width:18px;height:0;border-top-width:3px;border-top-style:solid;display:inline-block}
.swatch.control{border-color:var(--control)}
.swatch.data{border-color:var(--data)}
.kind-chip{display:inline-flex;align-items:center;justify-content:center;width:20px;height:15px;border:1px solid;border-radius:4px;font-size:10px;line-height:1;flex:0 0 auto}
.kind-chip.dashed{border-style:dashed}
.deps{display:flex;flex-direction:column;gap:5px}
.dep{display:flex;flex-direction:column;gap:1px;padding:5px 9px;border:1px dashed var(--line);border-radius:7px}
.dep-src{font-size:12.5px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--text)}
.dep-bind{font-size:11px;color:var(--muted)}
.main{flex:1;display:flex;flex-direction:column;min-width:0}
.breadcrumbs{display:flex;align-items:center;flex-wrap:wrap;gap:2px;padding:14px 20px;border-bottom:1px solid var(--line);min-height:50px}
.crumb{background:transparent;border:none;color:var(--text);cursor:pointer;font:inherit;padding:4px 8px;border-radius:6px}
.crumb:hover{background:var(--hover)}
.crumb:last-child{color:var(--accent);font-weight:600}
.crumb:last-child:hover{background:transparent;cursor:default}
.sep{color:var(--muted)}
.stage{position:relative;flex:1;min-height:0}
.canvas{display:none;position:absolute;inset:0;overflow:auto}
.canvas.active{display:block}
.canvas-scroll{padding:28px;min-width:max-content}
.kontur-canvas{display:block}
.node-link{cursor:pointer}
.node-link:hover rect:first-of-type{stroke-width:2.5}
.node-link:focus{outline:none}
.node-link:focus rect:first-of-type{stroke-width:2.5}
`;
}

const SCRIPT = `
(function(){
  var data = JSON.parse(document.getElementById('kontur-data').textContent);
  var TITLES = data.titles, FEATURES = data.features;
  var stack = [];
  var bc = document.getElementById('breadcrumbs');
  function name(id){ return TITLES[id] || id; }
  function render(){
    bc.innerHTML = stack.map(function(id,i){
      return '<button class="crumb" data-depth="'+i+'">'+escapeHtml(name(id))+'</button>';
    }).join('<span class="sep">/</span>');
    var cur = stack[stack.length-1];
    var els = document.querySelectorAll('.canvas');
    for (var i=0;i<els.length;i++) els[i].classList.toggle('active', els[i].getAttribute('data-module')===cur);
    var feats = document.querySelectorAll('.feature');
    for (var j=0;j<feats.length;j++) feats[j].classList.toggle('current', feats[j].getAttribute('data-module')===stack[0]);
  }
  function open(id){ stack=[id]; render(); }
  function push(id){ if(stack[stack.length-1]!==id){ stack.push(id); render(); } }
  function escapeHtml(s){ return String(s).replace(/[<>&]/g,function(c){return c==='<'?'&lt;':c==='>'?'&gt;':'&amp;';}); }
  document.addEventListener('click', function(e){
    var link = e.target.closest('[data-link]');
    if(link){ push(link.getAttribute('data-link')); return; }
    var crumb = e.target.closest('.crumb');
    if(crumb){ stack = stack.slice(0, parseInt(crumb.getAttribute('data-depth'),10)+1); render(); return; }
    var feat = e.target.closest('.feature');
    if(feat){ open(feat.getAttribute('data-module')); return; }
  });
  document.addEventListener('keydown', function(e){
    if(e.key==='Enter' || e.key===' '){
      var link = e.target.closest && e.target.closest('[data-link]');
      if(link){ e.preventDefault(); push(link.getAttribute('data-link')); }
    }
  });
  if(FEATURES.length) open(FEATURES[0]); else render();
})();
`;

function esc(s: string): string {
  return s.replace(/[<>&]/g, (c) => (c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;"));
}

function attr(s: string): string {
  return s.replace(/[<>&"]/g, (c) => (c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === "&" ? "&amp;" : "&quot;"));
}
