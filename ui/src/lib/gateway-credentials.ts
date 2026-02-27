const TOKEN_KEY = "verybot-gateway-token"

/** WebSocket endpoint path used by both client and server. */
export const WS_PATH = "/ws"

/**
 * Derive WebSocket URL from the current page location.
 * https -> wss, http -> ws. Falls back to env var for local dev.
 */
export function deriveWsUrl(): string {
  const envOverride = import.meta.env.VITE_GATEWAY_WS_URL
  if (envOverride) return envOverride

  const { protocol, host } = window.location
  const wsProtocol = protocol === "https:" ? "wss:" : "ws:"
  return `${wsProtocol}//${host}${WS_PATH}`
}

export function loadToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function saveToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token)
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY)
}
