export type ConnectorErrorCode =
  | "not_connected"
  | "auth"
  | "permission"
  | "not_found"
  | "rate_limited"
  | "invalid_request"
  | "timeout"
  | "upstream";

/**
 * Error raised by connectors. `message` says what went wrong; `hint` says what
 * the user (or the model) can do about it. Both are surfaced to Claude as an
 * `is_error` tool result so it can adapt instead of guessing.
 */
export class ConnectorError extends Error {
  constructor(
    readonly code: ConnectorErrorCode,
    message: string,
    readonly hint?: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ConnectorError";
  }
}

export interface HttpOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Attempts for 429/503 responses, including the first. */
  maxAttempts?: number;
  /** Upper bound for a single Retry-After wait. */
  maxRetryWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function retryAfterMs(res: Response, attempt: number): number {
  const header = res.headers.get("retry-after");
  const seconds = header === null ? Number.NaN : Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  return 500 * 2 ** attempt;
}

/**
 * fetch with a per-attempt timeout and Retry-After aware retries for 429/503.
 * Returns the final Response; the caller decides how to read provider errors.
 */
export async function request(url: string, init: RequestInit, options: HttpOptions = {}): Promise<Response> {
  const {
    fetch: doFetch = fetch,
    timeoutMs = 15_000,
    maxAttempts = 3,
    maxRetryWaitMs = 30_000,
    sleep = defaultSleep,
  } = options;

  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      if (err instanceof DOMException && err.name === "TimeoutError") {
        throw new ConnectorError("timeout", `Request to ${new URL(url).host} timed out after ${timeoutMs}ms`);
      }
      throw new ConnectorError("upstream", `Network error calling ${new URL(url).host}: ${(err as Error).message}`);
    }

    if ((res.status === 429 || res.status === 503) && attempt + 1 < maxAttempts) {
      const wait = retryAfterMs(res, attempt);
      if (wait <= maxRetryWaitMs) {
        await res.body?.cancel();
        await sleep(wait);
        continue;
      }
    }
    return res;
  }
}
