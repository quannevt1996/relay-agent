import Anthropic from "@anthropic-ai/sdk";
import type { Effort } from "../config.js";

export interface ModelTurnRequest {
  system: string;
  tools: Anthropic.Beta.BetaTool[];
  messages: Anthropic.Beta.BetaMessageParam[];
}

export interface ModelTurnOptions {
  onText?: (delta: string) => void;
  signal?: AbortSignal;
}

/** One model turn. The agent loop owns everything else, which keeps it testable with a scripted model. */
export interface ModelClient {
  readonly model: string;
  createTurn(request: ModelTurnRequest, options?: ModelTurnOptions): Promise<Anthropic.Beta.BetaMessage>;
}

// Models that accept the server-side refusal fallback (`fallbacks: "default"`).
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"]);
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const MAX_JSON_RETRIES = 2;

export class AnthropicModel implements ModelClient {
  constructor(
    private readonly client: Anthropic,
    readonly model: string,
    private readonly effort: Effort,
  ) {}

  async createTurn(request: ModelTurnRequest, { onText, signal }: ModelTurnOptions = {}): Promise<Anthropic.Beta.BetaMessage> {
    const fallback = FALLBACK_MODELS.has(this.model);
    for (let attempt = 0; ; attempt++) {
      const stream = this.client.beta.messages.stream(
        {
          model: this.model,
          max_tokens: 64_000,
          thinking: { type: "adaptive" },
          output_config: { effort: this.effort },
          ...(fallback ? { betas: [FALLBACK_BETA], fallbacks: "default" as const } : {}),
          // Breakpoint 1: tools + system (stable per skill). Breakpoint 2 (top-level):
          // the growing conversation, so each turn re-reads the previous ones from cache.
          system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
          cache_control: { type: "ephemeral" },
          tools: request.tools,
          tool_choice: { type: "auto" },
          messages: request.messages,
        },
        { signal },
      );
      if (onText) stream.on("text", onText);

      try {
        return await stream.finalMessage();
      } catch (err) {
        // With eager input streaming the SDK rejects when a tool input is not
        // parseable JSON at all. That turn never completed, so re-issue it;
        // API errors (auth, rate limit, overload) are the caller's to handle.
        if (err instanceof Anthropic.APIError || signal?.aborted || attempt >= MAX_JSON_RETRIES) throw err;
        console.warn("[relay] model emitted unparseable tool input; re-issuing the turn");
      }
    }
  }
}
