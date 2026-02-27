import { useState, useEffect } from "react"
import { useGatewayContext } from "@/contexts/gateway-context"

/** Fallback shown while backend is loading or unreachable. */
const FALLBACK_TOOLS = [
  "web_fetch",
  "browser_navigate",
  "browser_extract",
  "browser_observe",
  "browser_action",
  "bash",
  "memory_search",
]

let cachedTools: string[] | null = null

/** Fetch available tool names from the backend (cached, re-fetched on reconnect). */
export function useToolCatalog(): string[] {
  const { rpc, status } = useGatewayContext()
  const [tools, setTools] = useState<string[]>(cachedTools ?? FALLBACK_TOOLS)

  useEffect(() => {
    if (status !== "connected") return
    // Re-fetch on every reconnect so hot-restarts pick up new tools
    let cancelled = false

    rpc("tools.list")
      .then((result) => {
        if (cancelled) return
        const data = result as { tools: string[] }
        if (Array.isArray(data.tools) && data.tools.length > 0) {
          cachedTools = data.tools
          setTools(data.tools)
        }
      })
      .catch(() => {})

    return () => {
      cancelled = true
    }
  }, [rpc, status])

  return tools
}
