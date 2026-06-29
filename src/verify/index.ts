/**
 * Per-node verification harness. Decomposes "is this software correct?" into many
 * small, located questions — one per IR node — each answered from a bounded
 * verification slice rather than the whole codebase.
 *
 * The model call is injected (a `Verifier`), so this module stays pure and
 * dependency-free. A real deployment supplies a verifier that calls the Anthropic
 * API (e.g. a fast model like `claude-haiku-4-5` per node, fanned out); tests
 * supply a deterministic stub.
 */
import type { System } from "../ir/schema.js";
import { extractSlice, renderVerificationPrompt } from "./slice.js";

export * from "./slice.js";

export interface Verdict {
  /** true ⇒ the node matches its context; false ⇒ suspect / needs a human. */
  ok: boolean;
  reason: string;
}

/** A pluggable model call: prompt in, verdict out. */
export type Verifier = (prompt: string) => Promise<Verdict>;

export interface VerifyOptions {
  /** Original source text, so the slice can resolve `prov` spans to code. */
  source?: string;
  /** What this node is supposed to do — folded into the prompt if given. */
  intent?: string;
}

/** Verify a single node: build its slice, render the prompt, ask the verifier. */
export async function verifyNode(
  system: System,
  moduleId: string,
  nodeId: string,
  verifier: Verifier,
  opts: VerifyOptions = {},
): Promise<{ moduleId: string; nodeId: string; verdict: Verdict }> {
  const slice = extractSlice(system, moduleId, nodeId, opts.source);
  const prompt = renderVerificationPrompt(slice, opts.intent);
  const verdict = await verifier(prompt);
  return { moduleId, nodeId, verdict };
}

/**
 * Verify every provenance-bearing node across the whole system, concurrently.
 * Returns a coverage map — the located, per-node trust report. Nodes without
 * provenance (pure inlined sub-expressions) are skipped: they're verified as part
 * of the statement that contains them.
 */
export async function verifySystem(
  system: System,
  verifier: Verifier,
  opts: VerifyOptions = {},
): Promise<{ moduleId: string; nodeId: string; verdict: Verdict }[]> {
  const jobs: Promise<{ moduleId: string; nodeId: string; verdict: Verdict }>[] = [];
  for (const [moduleId, mod] of Object.entries(system.modules)) {
    for (const node of mod.interior.nodes) {
      if (!node.prov) continue;
      jobs.push(verifyNode(system, moduleId, node.id, verifier, opts));
    }
  }
  return Promise.all(jobs);
}
