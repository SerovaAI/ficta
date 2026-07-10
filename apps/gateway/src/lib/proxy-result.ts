/** Gateway-local failure while contacting or decoding the loopback ficta proxy. Never crosses the proxy wire. */
export interface ProxyCallError {
  ok: false;
  proxyUrl: string;
  status: "unreachable" | "bad_response";
  message: string;
  detail?: string;
}

export type ProxyCallResult<T extends { ok: true }> = T | ProxyCallError;
