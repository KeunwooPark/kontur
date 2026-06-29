import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateSystem } from "../ir/index.js";
import { transpile } from "./index.js";
import type { System } from "../ir/schema.js";

function load(name: string): System {
  const path = fileURLToPath(new URL(`../../examples/${name}`, import.meta.url));
  const result = validateSystem(JSON.parse(readFileSync(path, "utf8")));
  if (!result.ok) throw new Error(`example ${name} is invalid: ${JSON.stringify(result.issues)}`);
  return result.system;
}

/** The canonical FizzBuzz 1..15 output, the oracle both backends must match. */
const EXPECTED_FIZZBUZZ = [
  "1", "2", "Fizz", "4", "Buzz", "Fizz", "7", "8", "Fizz", "Buzz",
  "11", "Fizz", "13", "14", "FizzBuzz",
].join("\n");

function hasPython(): boolean {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("transpile: structure", () => {
  it("emits one function per module (TS)", () => {
    const ts = transpile(load("auth-search.kontur.json"), "ts");
    expect(ts).toContain("export function userLookup(email: string): User");
    expect(ts).toContain("export function login(email: string, password: string): Session");
    // shared module is CALLED, not re-emitted, from both callers
    expect(ts).toContain("const ul = userLookup(email);");
    expect(ts).toContain("const ul = userLookup(query);");
  });

  it("emits idiomatic snake_case for Python", () => {
    const py = transpile(load("auth-search.kontur.json"), "python");
    expect(py).toContain("def user_lookup(email: str) -> User:");
    expect(py).toContain("ul = user_lookup(email)");
    expect(py).toContain("verify_password(ul, password)");
  });

  it("lowers loop + nested branches for FizzBuzz (TS)", () => {
    const ts = transpile(load("fizzbuzz.kontur.json"), "ts");
    expect(ts).toContain("for (let i = 1; i <= n; i++)");
    expect(ts).toContain("(i % 15)");
    expect(ts).toContain('console.log("FizzBuzz")');
  });

  it("maps the inclusive loop to range(.., n + 1) in Python", () => {
    const py = transpile(load("fizzbuzz.kontur.json"), "python");
    expect(py).toContain("for i in range(1, n + 1):");
  });
});

describe("transpile: execution (same IR → same behavior)", () => {
  const dir = mkdtempSync(join(tmpdir(), "kontur-"));

  it("generated TypeScript runs and produces correct FizzBuzz", () => {
    const ts = transpile(load("fizzbuzz.kontur.json"), "ts");
    const file = join(dir, "fizzbuzz.ts");
    writeFileSync(file, `${ts}\nfizzbuzz(15);\n`);
    const tsx = fileURLToPath(new URL("../../node_modules/.bin/tsx", import.meta.url));
    const out = execFileSync(tsx, [file], { encoding: "utf8" }).trim();
    expect(out).toBe(EXPECTED_FIZZBUZZ);
  });

  it.skipIf(!hasPython())("generated Python runs and produces correct FizzBuzz", () => {
    const py = transpile(load("fizzbuzz.kontur.json"), "python");
    const file = join(dir, "fizzbuzz.py");
    writeFileSync(file, `${py}\nfizzbuzz(15)\n`);
    const out = execFileSync("python3", [file], { encoding: "utf8" }).trim();
    expect(out).toBe(EXPECTED_FIZZBUZZ);
  });
});
