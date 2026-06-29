/**
 * A real `Verifier` backed by the Anthropic API. Kept in its own module and
 * lazy-loading the SDK so the core (`slice.ts`, `index.ts`) stays pure and
 * dependency-free — only code that actually runs a model pulls the SDK in.
 *
 * Each call verifies ONE node's slice with a structured (schema-constrained)
 * response, so the verdict is always valid `{ ok, reason }`. At scale you fan
 * these out — one cheap/fast model per node (`claude-haiku-4-5`) is a good
 * default for a whole-system sweep; the default here is `claude-opus-4-8` for
 * maximum judgement quality on a single node.
 */
import type { Verdict, Verifier } from "./index.js";

export interface AnthropicVerifierOptions {
  /** Model id. Default `claude-opus-4-8`; pass `claude-haiku-4-5` for cheap fan-out. */
  model?: string;
  /** Output cap — a verdict is tiny, so this is small by default. */
  maxTokens?: number;
  /** Overrides the key the SDK would otherwise read from `ANTHROPIC_API_KEY`. */
  apiKey?: string;
  /** Replaces the default verifier persona. */
  system?: string;
}

const DEFAULT_SYSTEM =
  "You are a meticulous code verifier in a program-analysis pipeline. You are given " +
  "ONE statement of a program in isolation — its source, the enclosing function's " +
  "signature, the values it reads, the prior statements it depends on, and the " +
  "contracts of anything it calls. Judge ONLY from what you are given. Answer `ok` " +
  "when the statement plainly does what its context implies, and `suspect` when it " +
  "looks wrong, mismatched, or you cannot justify it from the slice. Keep the reason " +
  "to one sentence.";

export function anthropicVerifier(opts: AnthropicVerifierOptions = {}): Verifier {
  const model = opts.model ?? "claude-opus-4-8";
  const maxTokens = opts.maxTokens ?? 1024;
  const system = opts.system ?? DEFAULT_SYSTEM;

  // A raw JSON-schema structured output (no zod helper, to stay decoupled from
  // the SDK's bundled zod version). Constrains the reply to exactly `{ok, reason}`.
  const format = {
    type: "json_schema" as const,
    schema: {
      type: "object",
      properties: { ok: { type: "boolean" }, reason: { type: "string" } },
      required: ["ok", "reason"],
      additionalProperties: false,
    },
  };

  // Build the client once, lazily, on the first verification.
  let clientPromise: Promise<any> | undefined;
  const getClient = (): Promise<any> => {
    if (!clientPromise) {
      clientPromise = import("@anthropic-ai/sdk").then(
        ({ default: Anthropic }) => new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {}),
      );
    }
    return clientPromise;
  };

  return async (prompt: string): Promise<Verdict> => {
    const client = await getClient();
    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: prompt }],
      output_config: { format },
    });
    const text = response.content.find((b: { type: string }) => b.type === "text")?.text;
    if (!text) return { ok: false, reason: "verifier returned no structured output" };
    try {
      const parsed = JSON.parse(text) as { ok: boolean; reason: string };
      return { ok: Boolean(parsed.ok), reason: String(parsed.reason) };
    } catch {
      return { ok: false, reason: `verifier returned unparseable output: ${text.slice(0, 120)}` };
    }
  };
}
