// Shared HTTP helper with retry/backoff for provider rate limits (429) and
// transient errors (503). Free-tier embedding/chat quotas are strict, so this
// keeps indexing and asking robust without a backend.

const MAX_RETRIES = 6;
const BASE_DELAY_MS = 2000;
const MAX_DELAY_MS = 60000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parse a Google RetryInfo `retryDelay` ("38s" / "1.5s") from an error body. */
function parseRetryDelayMs(body: string): number | undefined {
  const m = body.match(/"retryDelay":\s*"(\d+(?:\.\d+)?)s"/);
  return m ? Math.ceil(parseFloat(m[1]) * 1000) : undefined;
}

function backoffMs(attempt: number): number {
  const exp = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
  return exp + Math.floor(Math.random() * 500); // jitter
}

/**
 * fetch() that retries on 429/503 with server-suggested or exponential backoff.
 * Returns the successful Response; throws a labelled error otherwise. Optionally
 * reports each wait so callers can surface "rate limited, waiting Ns…".
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  label: string,
  onRetry?: (waitMs: number, attempt: number) => void,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, init);
    if (res.ok) return res;

    const body = await res.text().catch(() => "");
    const retryable = res.status === 429 || res.status === 503;
    if (retryable && attempt < MAX_RETRIES) {
      const wait = parseRetryDelayMs(body) ?? backoffMs(attempt);
      onRetry?.(wait, attempt);
      await sleep(wait);
      continue;
    }
    throw new Error(`${label} failed (${res.status}): ${body.slice(0, 500)}`);
  }
}
