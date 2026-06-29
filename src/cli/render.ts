/**
 * Render a Kontur IR JSON file to a navigable HTML audit map.
 *   npm run render -- examples/fizzbuzz.kontur.json            # → stdout
 *   npm run render -- examples/auth-search.kontur.json out.html # → file
 *   npm run render -- examples/fizzbuzz.kontur.json --theme=ink # dark palette
 *
 * The default theme is `paper` (white background, academic palette).
 * A bad IR fails in the validator (component #1), never here.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { validateSystem } from "../ir/index.js";
import { render, themes, defaultTheme } from "../render/index.js";

const argv = process.argv.slice(2);
const themeArg = argv.find((a) => a.startsWith("--theme="))?.slice("--theme=".length);
const [path, out] = argv.filter((a) => !a.startsWith("--"));
if (!path) {
  console.error("usage: render <ir.json> [out.html] [--theme=paper|ink]");
  process.exit(2);
}

const theme = themeArg ? themes[themeArg] : defaultTheme;
if (!theme) {
  console.error(`unknown theme "${themeArg}" — available: ${Object.keys(themes).join(", ")}`);
  process.exit(2);
}

let raw: unknown;
try {
  raw = JSON.parse(readFileSync(path, "utf8"));
} catch (err) {
  console.error(`could not read/parse ${path}: ${(err as Error).message}`);
  process.exit(2);
}

const result = validateSystem(raw);
if (!result.ok) {
  console.error(`✗ invalid IR — refusing to render (${result.issues.length} issue(s)):`);
  for (const issue of result.issues) console.error(`  ${issue.path}: ${issue.message}`);
  process.exit(1);
}

const html = await render(result.system, theme);
if (out) {
  writeFileSync(out, html, "utf8");
  console.error(`✓ wrote ${out} (${Object.keys(result.system.modules).length} canvas(es))`);
} else {
  process.stdout.write(html);
}
