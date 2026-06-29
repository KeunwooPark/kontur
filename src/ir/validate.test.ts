import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateSystem } from "./index.js";
import type { System } from "./schema.js";

function loadExample(): System {
  const path = fileURLToPath(new URL("../../examples/auth-search.kontur.json", import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as System;
}

/** Deep clone so each test mutates an isolated copy. */
function fresh(): any {
  return loadExample();
}

describe("validateSystem", () => {
  it("accepts the canonical example", () => {
    const result = validateSystem(loadExample());
    expect(result.ok).toBe(true);
  });

  it("rejects a non-object", () => {
    const result = validateSystem(42);
    expect(result.ok).toBe(false);
  });

  it("rejects unknown extra keys (strict schema)", () => {
    const sys = fresh();
    sys.modules.login.surprise = true;
    const result = validateSystem(sys);
    expect(result.ok).toBe(false);
  });

  it("rejects a feature pointing at a missing module", () => {
    const sys = fresh();
    sys.features.push("ghost");
    const result = validateSystem(sys);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.message.includes("ghost"))).toBe(true);
    }
  });

  it("rejects a module node referencing a missing module", () => {
    const sys = fresh();
    sys.modules.login.interior.nodes[0].ref = "nope";
    const result = validateSystem(sys);
    expect(result.ok).toBe(false);
  });

  it("rejects a wire to a port that doesn't exist on a linked module's contract", () => {
    const sys = fresh();
    // userLookup has no "phone" port — a link cannot invent one (issue #5).
    sys.modules.login.interior.wires.push(["P:email", "ul:phone", "data"]);
    const result = validateSystem(sys);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.message.includes("phone"))).toBe(true);
    }
  });

  it("rejects a duplicate node id", () => {
    const sys = fresh();
    sys.modules.login.interior.nodes.push({ id: "chk", kind: "function", label: "dupe" });
    const result = validateSystem(sys);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.message.includes("duplicate node id"))).toBe(true);
    }
  });

  it("rejects a wire whose endpoint node does not exist", () => {
    const sys = fresh();
    sys.modules.login.interior.wires.push(["nope", "P:done", "control"]);
    const result = validateSystem(sys);
    expect(result.ok).toBe(false);
  });

  describe("port-boundary invariant", () => {
    it("rejects a declared port with no interior connection", () => {
      const sys = fresh();
      sys.modules.login.ports.push({ name: "extra", type: "string", io: "out", wire: "data" });
      const result = validateSystem(sys);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues.some((i) => i.message.includes("port-boundary invariant"))).toBe(true);
      }
    });

    it("rejects an in-port used as a wire target", () => {
      const sys = fresh();
      // email is an in-port; wiring something INTO it is backwards.
      sys.modules.login.interior.wires.push(["mk", "P:email", "data"]);
      const result = validateSystem(sys);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues.some((i) => i.message.includes("cannot be a wire target"))).toBe(true);
      }
    });

    it("rejects a wire whose kind disagrees with the boundary port kind", () => {
      const sys = fresh();
      // exec is a control port; wiring it as data must fail.
      sys.modules.login.interior.wires[0] = ["P:exec", "ul:exec", "data"];
      const result = validateSystem(sys);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues.some((i) => i.message.includes("does not match port"))).toBe(true);
      }
    });
  });

  it("confirms userLookup is shared by login and search with identical contracts", () => {
    const sys = loadExample();
    const fromLogin = sys.modules.login!.interior.nodes.find((n: any) => n.kind === "module");
    const fromSearch = sys.modules.search!.interior.nodes.find((n: any) => n.kind === "module");
    // Both link the SAME module id — the contract is derived from one place,
    // so it cannot diverge between callers.
    expect((fromLogin as any).ref).toBe("userLookup");
    expect((fromSearch as any).ref).toBe("userLookup");
  });
});
