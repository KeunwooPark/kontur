/**
 * Roots-first navigator — an alternative viewer shell for a lifted System.
 *
 * Where `renderHtml` (html.ts) lists every module flat in a file-ordered
 * sidebar, this renders the system as its LINK GRAPH: the root nodes (modules
 * nothing links into) come first, ranked by reach, and you descend by following
 * links — a class into its methods, a function into its callees. The `▸` module
 * boxes drawn on each canvas are live hyperlinks: clicking one opens the module
 * it points at, so you can navigate all the way to the leaves without ever
 * touching file structure. File origin is shown, never used to organise.
 *
 * Like `render`, it reuses the two rendering primitives — `layoutModule`
 * (elkjs) and `renderCanvasSvg` — and themes entirely from the passed `Theme`,
 * so it recolours for `paper` / `ink` without touching this logic.
 */
import type { System, Module } from "../ir/schema.js";
import { layoutModule } from "./layout.js";
import { renderCanvasSvg } from "./svg.js";
import { defaultTheme, type Theme } from "./theme.js";

const esc = (s: unknown): string =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Embed a value inside a `<script>` without letting `</…>` close the tag. */
const jsonSafe = (o: unknown): string => JSON.stringify(o).replace(/<\//g, "<\\/");

const localOf = (id: string): string => (id.includes("#") ? id.slice(id.indexOf("#") + 1) : id);
const kindOf = (id: string, mods: Record<string, Module>): "class" | "method" | "function" =>
  mods[id]!.kind === "class" ? "class" : localOf(id).includes(".") ? "method" : "function";
const originOf = (id: string, mods: Record<string, Module>): string => mods[id]!.origin ?? id.split("#")[0]!;

/** A Python-ish signature line derived from a module's ports (a class shows its bases). */
function signature(m: Module): string {
  if (m.kind === "class") return `class ${m.title}${m.bases && m.bases.length ? "(" + m.bases.join(", ") + ")" : ""}`;
  const ins = m.ports.filter((p) => p.io === "in" && p.wire === "data");
  const outs = m.ports.filter((p) => p.io === "out" && p.wire === "data");
  const ps = ins
    .map((p) => {
      let s = p.variadic === "args" ? "*" + p.name : p.variadic === "kwargs" ? "**" + p.name : p.name;
      if (p.type && p.type !== "any") s += ": " + p.type;
      if (p.default) s += "=" + (p.default.t === "lit" ? JSON.stringify(p.default.value) : p.default.t === "raw" ? p.default.src : p.default.name);
      return s;
    })
    .join(", ");
  return `${m.async ? "async " : ""}${m.title}(${ps})${outs.length ? " → " + outs.map((p) => p.type).join(", ") : ""}`;
}

/**
 * A validated System → a self-contained, roots-first navigable HTML document.
 * Every module is laid out once (elkjs) and its SVG injected lazily on the
 * client, so navigating 200+ canvases stays responsive.
 */
export async function renderNavigator(system: System, theme: Theme = defaultTheme): Promise<string> {
  const mods = system.modules;
  const ids = Object.keys(mods);

  // --- link graph: a `module` node inside an interior is a hyperlink -------
  // A nested (local) function also belongs to its defining parent (`nestedIn`) — a
  // STRUCTURAL edge, so a nested fn referenced only as a value (an escaping closure,
  // which has no call-link) still nests under its parent instead of floating as a root.
  const nestedChildren: Record<string, string[]> = {};
  for (const id of ids) {
    const parent = mods[id]!.nestedIn;
    if (parent && mods[parent]) (nestedChildren[parent] ??= []).push(id);
  }
  const out: Record<string, string[]> = {};
  const indeg: Record<string, number> = {};
  for (const id of ids) { out[id] = []; indeg[id] ??= 0; }
  for (const id of ids) {
    const seen = new Set<string>();
    for (const n of mods[id]!.interior.nodes)
      if (n.kind === "module" && mods[n.ref] && n.ref !== id && !seen.has(n.ref)) {
        seen.add(n.ref); out[id]!.push(n.ref); indeg[n.ref] = (indeg[n.ref] ?? 0) + 1;
      }
    // Add each nested child not already reached by a call-link (dedup), so it shows
    // once under its parent and gains an in-edge (no longer a spurious root).
    for (const child of nestedChildren[id] ?? [])
      if (child !== id && !seen.has(child)) {
        seen.add(child); out[id]!.push(child); indeg[child] = (indeg[child] ?? 0) + 1;
      }
  }
  const odeg = (id: string): number => out[id]!.length;
  for (const id of ids) out[id]!.sort((a, b) => odeg(b) - odeg(a) || a.localeCompare(b));
  // Roots = modules nothing links into, richest subtree first.
  const roots = ids.filter((id) => (indeg[id] ?? 0) === 0).sort((a, b) => odeg(b) - odeg(a) || a.localeCompare(b));

  // --- per-module canvas + metadata ---------------------------------------
  const svgs: Record<string, string> = {};
  const meta: Record<string, unknown> = {};
  for (const id of ids) {
    svgs[id] = renderCanvasSvg(await layoutModule(id, system), theme);
    const m = mods[id]!;
    meta[id] = {
      title: m.title, kind: kindOf(id, mods), origin: originOf(id, mods), sig: signature(m),
      doc: m.doc ?? "", bases: m.bases ?? [], decorators: m.decorators ?? [],
      nodes: m.interior.nodes.length, wires: m.interior.wires.length, odeg: odeg(id), indeg: indeg[id] ?? 0,
    };
  }

  const totals = {
    modules: ids.length,
    roots: roots.length,
    classes: roots.filter((r) => kindOf(r, mods) === "class").length,
    funcs: roots.filter((r) => kindOf(r, mods) === "function").length,
  };
  const title = system.features.length && mods[system.features[0]!] ? originOf(system.features[0]!, mods).replace(/\.\w+$/, "") : "system";

  const T = theme;
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Kontur system roots</title>
<style>
  :root{
    --bg:${T.bg};--panel:${T.panel};--line:${T.line};--ink:${T.text};--muted:${T.textMuted};
    --hover:${T.surfaceHover};--accent:${T.accent};--accentSoft:${T.accentSoft};--accentText:${T.accentText};
    --kClass:${T.kinds.module.stroke};--kMethod:${T.kinds.method.stroke};--kFunc:${T.kinds.function.stroke};
    --drift:#b07714;
    --line2:color-mix(in srgb,var(--line) 55%,var(--bg));
    --faint:color-mix(in srgb,var(--muted) 62%,var(--bg));
    --canvasBg:color-mix(in srgb,var(--bg) 88%,var(--line));
    --dot:color-mix(in srgb,var(--line) 70%,var(--bg));
    --kClassSoft:color-mix(in srgb,var(--kClass) 14%,var(--bg));
    --kMethodSoft:color-mix(in srgb,var(--kMethod) 14%,var(--bg));
  }
  *{box-sizing:border-box}
  body{margin:0;height:100vh;background:var(--bg);color:var(--ink);
    font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;line-height:1.5;-webkit-font-smoothing:antialiased}
  .app{display:grid;grid-template-columns:370px 1fr;height:100vh;min-height:0}
  @media(max-width:760px){.app{grid-template-columns:1fr;grid-template-rows:44vh 1fr}}

  .rail{background:var(--panel);border-right:1px solid var(--line);display:flex;flex-direction:column;min-height:0}
  .railhead{padding:15px 18px 12px;border-bottom:1px solid var(--line)}
  .brand{font-size:12px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--accent)}
  .brand b{color:var(--ink)}
  .tot{font-size:12px;color:var(--muted);margin-top:5px}
  .tot b{color:var(--ink);font-variant-numeric:tabular-nums}
  .rootlabel{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--faint);margin:12px 2px 2px;font-weight:600}
  .search{margin-top:10px;width:100%;padding:7px 10px;border:1px solid var(--line);border-radius:7px;
    font-size:13px;font-family:ui-monospace,Menlo,monospace;background:var(--bg);color:var(--ink)}
  .search:focus{outline:2px solid var(--accentSoft);border-color:var(--accent)}
  .tree{overflow-y:auto;padding:6px 8px 50px;flex:1;min-height:0}

  .row{display:flex;align-items:center;gap:7px;padding:4px 8px;border-radius:6px;cursor:pointer;
    font-family:ui-monospace,Menlo,monospace;font-size:12.5px;white-space:nowrap}
  .row:hover{background:var(--hover)}
  .row.sel{background:var(--accentSoft);color:var(--accentText);box-shadow:inset 2px 0 0 var(--accent)}
  .chev{width:11px;flex:none;color:var(--faint);font-size:10px;text-align:center;cursor:pointer}
  .chev.none{visibility:hidden}
  .gl{width:8px;height:8px;border-radius:2px;flex:none}
  .gl.class{background:var(--kClass)}.gl.method{background:var(--kMethod)}.gl.function{background:var(--kFunc)}
  .lname{overflow:hidden;text-overflow:ellipsis}
  .org{color:var(--faint);font-size:10.5px}
  .odeg{margin-left:auto;font-size:10px;color:var(--faint);font-variant-numeric:tabular-nums;
    background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:0 6px;flex:none}
  .row:hover .odeg{background:transparent}
  .cyc{margin-left:auto;color:var(--drift);font-size:10.5px;flex:none}
  .kids{overflow:hidden}

  .detail{display:flex;flex-direction:column;min-height:0;overflow:hidden}
  .dhead{padding:17px 26px 15px;border-bottom:1px solid var(--line);background:var(--bg)}
  .crumb{font-size:12px;color:var(--faint);font-family:ui-monospace,Menlo,monospace;display:flex;gap:7px;align-items:center;flex-wrap:wrap}
  .badge{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;padding:2px 7px;border-radius:5px}
  .badge.class{background:var(--kClassSoft);color:var(--kClass)}
  .badge.function{background:var(--accentSoft);color:var(--kFunc)}
  .badge.method{background:var(--kMethodSoft);color:var(--kMethod)}
  .dsig{font-family:ui-monospace,Menlo,monospace;font-size:16px;font-weight:600;margin:9px 0 0;
    letter-spacing:-.01em;overflow-x:auto;white-space:pre;padding-bottom:2px}
  .ddoc{color:var(--muted);font-size:13px;margin:8px 0 0;max-width:80ch;white-space:pre-wrap;
    max-height:40vh;overflow-y:auto;overscroll-behavior:contain;padding-right:10px;
    border-left:2px solid var(--line2);padding-left:11px}
  .ddoc::-webkit-scrollbar{width:8px}
  .ddoc::-webkit-scrollbar-thumb{background:var(--line);border-radius:4px}
  .dmeta{display:flex;gap:15px;margin-top:11px;font-size:11.5px;color:var(--faint);font-variant-numeric:tabular-nums;flex-wrap:wrap}
  .dmeta b{color:var(--muted);font-weight:600}.deco{color:var(--drift)}
  .canvas{flex:1;min-height:0;overflow:auto;padding:26px;
    background:radial-gradient(circle at 1px 1px,var(--dot) 1px,transparent 0) 0 0/22px 22px,var(--canvasBg)}
  .canvas svg{display:block;height:auto;max-width:none}
  .canvas .node-link{cursor:pointer}
  .canvas .node-link:hover>rect:first-of-type,.canvas .node-link:focus>rect:first-of-type{stroke:var(--accent);stroke-width:2.5}
  .canvas .node-link:focus{outline:none}
  .hint{color:var(--faint);font-size:12px;padding:6px 26px;border-top:1px solid var(--line);background:var(--bg)}
  .back{border:1px solid var(--line);background:var(--bg);color:var(--accent);border-radius:6px;
    font-size:12px;padding:2px 9px;cursor:pointer;font-family:inherit}
  .back:hover:not(:disabled){background:var(--accentSoft)}
  .back:disabled{color:var(--faint);cursor:default;opacity:.6}
</style></head><body>

<div class="app">
  <aside class="rail">
    <div class="railhead">
      <div class="brand"><b>${esc(title)}</b> · system roots</div>
      <div class="tot"><b>${totals.roots}</b> root nodes — modules nothing links into · reach the other <b>${totals.modules - totals.roots}</b> by following links</div>
      <input class="search" id="q" type="search" placeholder="find a module…" autocomplete="off" aria-label="find a module">
      <div class="rootlabel">roots · ranked by reach ↓</div>
    </div>
    <nav class="tree" id="tree"></nav>
  </aside>
  <main class="detail">
    <div class="dhead">
      <div class="crumb" id="crumb"><button class="back" id="back" title="back" disabled>← back</button><span id="crumbtext"></span></div>
      <div class="dsig" id="sig"></div>
      <div class="ddoc" id="doc"></div>
      <div class="dmeta" id="metarow"></div>
    </div>
    <div class="canvas" id="canvas"></div>
    <div class="hint"><b>Click a ▸ box in the canvas</b> to follow that link into the module it opens — drill to the leaves. ← back returns. A tree row expands a class into its methods / a function into its callees; ↩ marks a link back to an ancestor.</div>
  </main>
</div>

<script>
const LINKS=${jsonSafe(out)}, META=${jsonSafe(meta)}, SVGS=${jsonSafe(svgs)}, ROOTS=${jsonSafe(roots)};
const tree=document.getElementById("tree"), $=(id)=>document.getElementById(id);

function makeRow(id, depth, ancestors){
  const m=META[id], links=LINKS[id]||[], isCyc=ancestors.includes(id), canExpand=links.length&&!isCyc;
  const branch=document.createElement("div"); branch.className="branch";
  const row=document.createElement("div"); row.className="row"; row.dataset.id=id;
  row.style.paddingLeft=(depth*15+8)+"px";
  const org=depth>0?'<span class="org">'+m.origin.replace(/\\.\\w+$/,"")+'</span>':'';
  row.innerHTML='<span class="chev'+(canExpand?"":" none")+'">'+(canExpand?"▸":"")+'</span>'+
    '<span class="gl '+m.kind+'"></span><span class="lname">'+m.title+'</span>'+org+
    (isCyc?'<span class="cyc">↩</span>':'<span class="odeg">'+links.length+'</span>');
  branch.appendChild(row);
  const kids=document.createElement("div"); kids.className="kids"; kids.hidden=true; branch.appendChild(kids);
  let built=false; const chev=row.querySelector(".chev");
  const build=()=>{ if(!built){ for(const c of links) kids.appendChild(makeRow(c,depth+1,ancestors.concat(id))); built=true; } };
  const setOpen=(o)=>{ if(!canExpand)return; if(o)build(); kids.hidden=!o; chev.textContent=o?"▾":"▸"; };
  chev.addEventListener("click",(e)=>{e.stopPropagation(); setOpen(kids.hidden);});
  row.addEventListener("click",()=>{ if(canExpand&&kids.hidden)setOpen(true); go(id); });
  return branch;
}

let cur=null; const hist=[];
function show(id){
  const m=META[id]; if(!m)return;
  document.querySelectorAll(".row.sel").forEach(e=>e.classList.remove("sel"));
  const el=[...tree.querySelectorAll('.row[data-id="'+CSS.escape(id)+'"]')].find(e=>e.offsetParent!==null)||tree.querySelector('.row[data-id="'+CSS.escape(id)+'"]');
  if(el){el.classList.add("sel"); el.scrollIntoView({block:"nearest"});}
  $("crumbtext").innerHTML='<span>'+m.origin+'</span><span class="badge '+m.kind+'">'+m.kind+'</span>'+
    (m.indeg?'<span style="color:var(--faint)">'+m.indeg+' caller'+(m.indeg>1?'s':'')+'</span>':'<span style="color:var(--kMethod)">root</span>');
  $("sig").textContent=m.sig;
  $("doc").textContent=m.doc||""; $("doc").style.display=m.doc?"":"none";
  const r=[]; if(m.kind!=="class"){r.push('<span><b>'+m.nodes+'</b> nodes</span>','<span><b>'+m.wires+'</b> wires</span>');}
  else r.push('<span><b>'+m.nodes+'</b> members</span>');
  r.push('<span><b>'+m.odeg+'</b> outgoing links</span>');
  if(m.bases.length)r.push('<span>extends <b>'+m.bases.map(b=>b.split("[")[0]).join(", ")+'</b></span>');
  if(m.decorators.length)r.push('<span class="deco">@'+m.decorators.join(" @")+'</span>');
  $("metarow").innerHTML=r.join("");
  $("canvas").innerHTML=SVGS[id]||""; $("canvas").scrollTop=0;
  $("canvas").querySelectorAll("[data-link]").forEach(n=>{
    const ref=n.getAttribute("data-link");
    if(!META[ref]){ n.style.cursor="default"; return; }
    n.addEventListener("click",()=>go(ref));
    n.addEventListener("keydown",(e)=>{ if(e.key==="Enter"||e.key===" "){e.preventDefault();go(ref);} });
    const tt=document.createElementNS("http://www.w3.org/2000/svg","title"); tt.textContent="→ open "+META[ref].title; n.appendChild(tt);
  });
}
function go(id, record=true){ if(!META[id])return; if(record&&cur&&cur!==id)hist.push(cur); cur=id; show(id); $("back").disabled=!hist.length; }
function back(){ const p=hist.pop(); if(p){cur=p; show(p);} $("back").disabled=!hist.length; }
$("back").addEventListener("click",back);

for(const r of ROOTS) tree.appendChild(makeRow(r,0,[]));
$("q").addEventListener("input",(e)=>{
  const q=e.target.value.trim().toLowerCase();
  tree.querySelectorAll(":scope > .branch > .row").forEach(row=>{
    const hit=!q||row.querySelector(".lname").textContent.toLowerCase().includes(q);
    row.parentElement.style.display=hit?"":"none";
  });
});
if(ROOTS.length) go(ROOTS[0]);
</script></body></html>`;
}
