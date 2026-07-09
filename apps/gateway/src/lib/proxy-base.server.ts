const DEFAULT_PROXY_URL = "http://127.0.0.1:8787";

/** Base URL of the local ficta proxy. */
export function proxyBaseUrl(): string {
  return stripTrailingSlash(process.env.FICTA_PROXY_URL ?? DEFAULT_PROXY_URL);
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}
