/**
 * Canonical outbound HTTP retry helper for this repo.
 *
 * Use this for any outbound HTTP call that may hit 429 (rate-limit) or 5xx
 * (transient server error). It wraps every attempt in an AbortController-
 * bounded timeout, retries with quadratic backoff on 429/5xx, and throws a
 * descriptive Error after `maxRetries` exhaustion.
 *
 * Any other non-2xx answer (403, 404, 400, …) is NOT retried: it throws a
 * `NonRetryableHttpError` on the first attempt, carrying the status. Re-sending
 * a request the server has refused on its merits only delays the failure and
 * dresses a credential problem up as a transient outage. Network errors and
 * timeouts still retry.
 *
 * First real consumer: Epic E.2 (audit-stream webhook delivery).
 *
 * @param input  - The URL or Request to fetch.
 * @param init   - Standard `fetch` init options (headers, method, body, …).
 * @param options.timeout    - Per-attempt timeout in ms (default 5 000).
 * @param options.maxRetries - Maximum attempts before throwing (default 10).
 * @param options.retryDelay - Base delay between retries in ms (default 1 000).
 */
export class NonRetryableHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'NonRetryableHttpError';
    this.status = status;
  }
}

export async function fetchWithRetry(
  input: RequestInfo | URL,
  init?: RequestInit | undefined,
  options: {
    timeout?: number;
    maxRetries?: number;
    retryDelay?: number;
  } = {},
): Promise<Response> {
  const { timeout = 5000, maxRetries = 10, retryDelay = 1000 } = options;

  let lastError: Error | null = null;

  for (let i = 0; i < maxRetries; i++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, timeout);

    try {
      const response = await fetch(input, {
        ...init,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        return response;
      }

      // Handle rate limiting and server errors
      if (response.status === 429 || response.status >= 500) {
        const delay = retryDelay + Math.pow(i, 2) * 50;
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      // Handle unauthorized errors
      if (response.status === 403) {
        throw new NonRetryableHttpError(403, "Unauthorized");
      }

      // Handle other errors
      if (!response.ok) {
        let errorMessage: string;
        try {
          const error = await response.json();
          errorMessage = error.error || `HTTP error ${response.status}`;
        } catch {
          errorMessage = `HTTP error ${response.status}`;
        }
        throw new NonRetryableHttpError(response.status, errorMessage);
      }
    } catch (error) {
      clearTimeout(timeoutId);
      // The server refused this request on its merits: re-sending it
      // changes nothing, so surface the refusal now.
      if (error instanceof NonRetryableHttpError) throw error;
      lastError = error instanceof Error ? error : new Error(String(error));

      // If this is the last retry, throw the error
      if (i === maxRetries - 1) {
        const errMsg = `Failed after ${maxRetries} retries. Last error: ${lastError.message}`;
        throw new Error(errMsg);
      }

      // For network errors or timeouts, wait and retry
      const delay = retryDelay + Math.pow(i, 2) * 50;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // This should never be reached due to the throw in the last retry,
  // but TypeScript needs it for type safety
  throw new Error(`Failed after ${maxRetries} retries`);
}
