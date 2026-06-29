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
import type { System } from "../ir/schema.js";

export interface Canvas {
  moduleId: string;
  title: string;
  svg: string;
}

export function renderHtml(system: System, canvases: Canvas[]): string {
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

  const bootData = JSON.stringify({ titles, features });

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Kontur — ${esc(systemTitle(system, titles))}</title>
<style>${CSS}</style>
</head>
<body>
<aside class="sidebar">
  <div class="brand">Kontur</div>
  <div class="brand-sub">audit map</div>
  <div class="section-label">Features</div>
  <nav class="features">${featureList || '<div class="empty">no features</div>'}</nav>
  <div class="legend">
    <div class="section-label">Legend</div>
    <div class="legend-row"><span class="swatch control"></span>control wire — execution order</div>
    <div class="legend-row"><span class="swatch data"></span>data wire — values</div>
    <div class="legend-row"><span class="dot link"></span>module — click to descend</div>
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

const CSS = `
:root{--bg:#0e1116;--panel:#11151c;--line:#222936;--text:#e6e9ef;--muted:#8b93a7;--accent:#36c6d6;}
*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{display:flex;background:var(--bg);color:var(--text);font:14px/1.4 ui-sans-serif,system-ui,-apple-system,sans-serif}
.sidebar{width:240px;flex:0 0 240px;border-right:1px solid var(--line);padding:18px 16px;overflow:auto}
.brand{font-weight:650;font-size:18px;letter-spacing:.02em}
.brand-sub{color:var(--muted);font-size:12px;margin-bottom:20px}
.section-label{text-transform:uppercase;letter-spacing:.08em;font-size:11px;color:var(--muted);margin:18px 0 8px}
.features{display:flex;flex-direction:column;gap:4px}
.feature{display:block;width:100%;text-align:left;background:transparent;border:1px solid transparent;color:var(--text);padding:7px 10px;border-radius:7px;cursor:pointer;font:inherit}
.feature:hover{background:#161b24}
.feature.current{background:#0f2e33;border-color:var(--accent);color:#bff0f6}
.empty{color:var(--muted);font-size:13px}
.legend{margin-top:8px}
.legend-row{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:12px;margin:6px 0}
.swatch{width:18px;height:0;border-top-width:3px;border-top-style:solid;display:inline-block}
.swatch.control{border-color:#e7eaf3}
.swatch.data{border-color:#5b9cff}
.dot.link{width:11px;height:11px;border:1.5px solid var(--accent);border-radius:3px;display:inline-block}
.main{flex:1;display:flex;flex-direction:column;min-width:0}
.breadcrumbs{display:flex;align-items:center;flex-wrap:wrap;gap:2px;padding:14px 20px;border-bottom:1px solid var(--line);min-height:50px}
.crumb{background:transparent;border:none;color:var(--text);cursor:pointer;font:inherit;padding:4px 8px;border-radius:6px}
.crumb:hover{background:#161b24}
.crumb:last-child{color:var(--accent);font-weight:600}
.crumb:last-child:hover{background:transparent;cursor:default}
.sep{color:var(--muted)}
.stage{position:relative;flex:1;min-height:0}
.canvas{display:none;position:absolute;inset:0;overflow:auto}
.canvas.active{display:block}
.canvas-scroll{padding:28px;min-width:max-content}
.kontur-canvas{display:block}
.node-link{cursor:pointer}
.node-link:hover rect{filter:brightness(1.25)}
.node-link:focus{outline:none}
.node-link:focus rect:first-of-type{stroke-width:2.5}
`;

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
