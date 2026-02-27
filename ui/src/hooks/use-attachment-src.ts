import { useState, useEffect } from "react"
import { useGatewayContext } from "@/contexts/gateway-context"

/** Module-level cache: attachment id -> data URL */
const urlCache = new Map<string, string>()

/**
 * Loads an attachment image via RPC and returns a data URL.
 * Caches results so each attachment is fetched only once.
 */
export function useAttachmentSrc(id: string): string | null {
  const { rpc } = useGatewayContext()
  const [src, setSrc] = useState<string | null>(() => urlCache.get(id) ?? null)

  useEffect(() => {
    if (urlCache.has(id)) {
      setSrc(urlCache.get(id)!)
      return
    }

    let cancelled = false
    rpc("tasks.getAttachment", { id })
      .then((res) => {
        if (cancelled) return
        const { data, type } = res as { data: string; type: string }
        const dataUrl = `data:${type};base64,${data}`
        urlCache.set(id, dataUrl)
        setSrc(dataUrl)
      })
      .catch(() => {
        /* attachment may have been deleted */
      })

    return () => { cancelled = true }
  }, [id, rpc])

  return src
}
