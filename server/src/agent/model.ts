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

// Models that return the notes they write between tool calls as thinking
// blocks. `display: "updates"` asks for a short readable summary of each note
// (the reasoning itself stays hidden), which the trace shows as progress.
const PROGRESS_UPDATE_MODELS = new Set(["claude-opus-5-5", "claude-fable-5-1", "claude-fable-5", "claude-sonnet-5-5"]);
const PROGRESS_UPDATE_BETA = "thinking-display-updates-2026-08-18";

const MAX_JSON_RETRIES = 2;

export class AnthropicModel implements ModelClient {
  constructor(
    private readonly client: Anthropic,
    readonly model: string,
    private readonly effort: Effort,
  ) {}

  async createTurn(request: ModelTurnRequest, { onText, signal }: ModelTurnOptions = {}): Promise<Anthropic.Beta.BetaMessage> {
    const fallback = FALLBACK_MODELS.has(this.model);
    const progress = PROGRESS_UPDATE_MODELS.has(this.model);
    const betas = [...(fallback ? [FALLBACK_BETA] : []), ...(progress ? [PROGRESS_UPDATE_BETA] : [])];

    for (let attempt = 0; ; attempt++) {
      const stream = this.client.beta.messages.stream(
        {
          model: this.model,
          max_tokens: 64_000,
          thinking: progress ? { type: "adaptive", display: "updates" } : { type: "adaptive" },
          output_config: { effort: this.effort },
          ...(betas.length ? { betas } : {}),
          ...(fallback ? { fallbacks: "default" as const } : {}),
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

/** Turns SDK errors into a sentence for the run trace. */
export function describeModelError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) {
    return "The Anthropic API rejected the credentials (401). Check ANTHROPIC_API_KEY.";
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return `The Anthropic API denied access to this model (403): ${err.message}`;
  }
  if (err instanceof Anthropic.RateLimitError) {
    return "Rate limited by the Anthropic API after retrying. Try again in a minute.";
  }
  if (err instanceof Anthropic.BadRequestError) {
    return `The Anthropic API rejected the request (400): ${err.message}`;
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return `Could not reach the Anthropic API: ${err.message}`;
  }
  if (err instanceof Anthropic.APIError) {
    return `Anthropic API error${err.status ? ` ${err.status}` : ""}: ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}
