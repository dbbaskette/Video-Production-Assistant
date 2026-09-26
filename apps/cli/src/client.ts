export class VpaCliError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'VpaCliError';
  }
}

export interface HttpClient {
  json<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    options?: { headers?: Record<string, string> },
  ): Promise<T>;
  bytes(path: string): Promise<Uint8Array>;
}

function apiErrorBody(value: unknown): { error?: string; code?: string; details?: unknown } {
  return value && typeof value === 'object'
    ? (value as { error?: string; code?: string; details?: unknown })
    : {};
}

export class VpaHttpClient implements HttpClient {
  readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  private url(path: string): string {
    return new URL(path, `${this.baseUrl}/`).toString();
  }

  async json<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    options: { headers?: Record<string, string> } = {},
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.url(path), {
        method,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...options.headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new VpaCliError(
        `VPA is unavailable at ${this.baseUrl}. Start it with ./start.sh. (${detail})`,
        'vpa_unavailable',
      );
    }

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { error: text || response.statusText };
    }
    if (!response.ok) {
      const apiError = apiErrorBody(parsed);
      throw new VpaCliError(
        apiError.error ?? `VPA request failed (${response.status})`,
        apiError.code ?? 'api_error',
        response.status,
        apiError.details,
      );
    }
    return parsed as T;
  }

  async bytes(path: string): Promise<Uint8Array> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.url(path));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new VpaCliError(
        `VPA is unavailable at ${this.baseUrl}. Start it with ./start.sh. (${detail})`,
        'vpa_unavailable',
      );
    }
    if (!response.ok) {
      throw new VpaCliError(
        `Audio download failed (${response.status})`,
        'download_failed',
        response.status,
      );
    }
    return new Uint8Array(await response.arrayBuffer());
  }
}
