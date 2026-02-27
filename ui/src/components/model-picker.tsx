import { useState, useEffect, useRef, useCallback, useMemo } from "react"
import { createPortal } from "react-dom"
import { useGatewayContext } from "@/contexts/gateway-context"
import { Input } from "@/components/ui/input"
import { stripModelOptions } from "@/lib/model-spec"
import { cn } from "@/lib/utils"

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface ModelEntry {
  value: string
  group: string
  contextWindow: number
}

/* ------------------------------------------------------------------ */
/*  Fallback — shown while backend is loading or unreachable           */
/* ------------------------------------------------------------------ */

const FALLBACK_MODELS: ModelEntry[] = [
  { value: "anthropic:claude-sonnet-4-5-20250929", group: "Anthropic", contextWindow: 200_000 },
  { value: "openai:gpt-4o", group: "OpenAI", contextWindow: 128_000 },
  { value: "google:gemini-2.5-pro", group: "Google", contextWindow: 1_000_000 },
]

/* ------------------------------------------------------------------ */
/*  Hook: shared model catalog from backend                            */
/* ------------------------------------------------------------------ */

let cachedModels: ModelEntry[] | null = null

export function useModelCatalog(): ModelEntry[] {
  const { rpc, status } = useGatewayContext()
  const [models, setModels] = useState<ModelEntry[]>(cachedModels ?? FALLBACK_MODELS)

  useEffect(() => {
    if (status !== "connected") return
    let cancelled = false

    rpc("models.list").then((result) => {
      if (cancelled) return
      const data = result as { models: ModelEntry[] }
      if (Array.isArray(data.models) && data.models.length > 0) {
        cachedModels = data.models
        setModels(data.models)
      }
    }).catch(() => {})

    return () => { cancelled = true }
  }, [rpc, status])

  return models
}

/** Lookup context window for a model string from the catalog. Returns 0 if not found. */
export function lookupContextWindow(catalog: ModelEntry[], model: string): number {
  const baseModel = stripModelOptions(model)
  const entry = catalog.find((m) => m.value === baseModel)
  return entry?.contextWindow ?? 0
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

interface ModelPickerProps {
  value: string
  onValueChange: (v: string) => void
  className?: string
}

export function ModelPicker({ value, onValueChange, className }: ModelPickerProps) {
  const models = useModelCatalog()
  const [open, setOpen] = useState(false)
  const [highlightIndex, setHighlightIndex] = useState(-1)
  const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({})
  const wrapperRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Filter suggestions based on current input
  const filtered = useMemo(() => {
    if (!value) return models
    const q = value.toLowerCase()
    return models.filter((m) => m.value.toLowerCase().includes(q))
  }, [models, value])

  // Group filtered results
  const grouped = useMemo(() => {
    const map = new Map<string, ModelEntry[]>()
    for (const m of filtered) {
      const list = map.get(m.group) ?? []
      list.push(m)
      map.set(m.group, list)
    }
    return map
  }, [filtered])

  // Position dropdown below input and close on outside click
  useEffect(() => {
    if (!open) return

    function updatePosition() {
      if (!inputRef.current) return
      const rect = inputRef.current.getBoundingClientRect()
      setDropdownStyle({
        position: "fixed",
        top: rect.bottom + 4,
        left: rect.left,
        width: rect.width,
      })
    }

    function handleClick(e: MouseEvent) {
      if (
        wrapperRef.current && !wrapperRef.current.contains(e.target as Node) &&
        listRef.current && !listRef.current.contains(e.target as Node)
      ) {
        setOpen(false)
      }
    }

    updatePosition()
    document.addEventListener("mousedown", handleClick)
    window.addEventListener("scroll", updatePosition, true)
    window.addEventListener("resize", updatePosition)
    return () => {
      document.removeEventListener("mousedown", handleClick)
      window.removeEventListener("scroll", updatePosition, true)
      window.removeEventListener("resize", updatePosition)
    }
  }, [open])

  // Scroll highlighted item into view
  useEffect(() => {
    if (highlightIndex < 0 || !listRef.current) return
    const items = listRef.current.querySelectorAll("[data-item]")
    items[highlightIndex]?.scrollIntoView({ block: "nearest" })
  }, [highlightIndex])

  const selectItem = useCallback((val: string) => {
    onValueChange(val)
    setOpen(false)
    setHighlightIndex(-1)
  }, [onValueChange])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      setOpen(true)
      setHighlightIndex(0)
      e.preventDefault()
      return
    }

    if (!open) return

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault()
        setHighlightIndex((i) => (i + 1) % filtered.length)
        break
      case "ArrowUp":
        e.preventDefault()
        setHighlightIndex((i) => (i - 1 + filtered.length) % filtered.length)
        break
      case "Enter":
        e.preventDefault()
        if (highlightIndex >= 0 && highlightIndex < filtered.length) {
          selectItem(filtered[highlightIndex].value)
        } else {
          setOpen(false)
        }
        break
      case "Escape":
        setOpen(false)
        setHighlightIndex(-1)
        break
    }
  }, [open, filtered, highlightIndex, selectItem])

  return (
    <div ref={wrapperRef}>
      <Input
        ref={inputRef}
        value={value}
        onChange={(e) => {
          onValueChange(e.target.value)
          setOpen(true)
          setHighlightIndex(-1)
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
        placeholder="provider:model-id"
        className={className}
      />

      {open && filtered.length > 0 && createPortal(
        <div
          ref={listRef}
          style={dropdownStyle}
          className="z-50 overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg"
        >
          <div className="max-h-64 overflow-y-auto p-1">
            {[...grouped.entries()].map(([group, items]) => (
              <div key={group}>
                <div className="px-3 py-1.5 text-xs font-medium text-muted-foreground">
                  {group}
                </div>
                {items.map((m) => {
                  const idx = filtered.indexOf(m)
                  return (
                    <div
                      key={m.value}
                      data-item
                      onMouseDown={(e) => {
                        e.preventDefault()
                        selectItem(m.value)
                      }}
                      onMouseEnter={() => setHighlightIndex(idx)}
                      className={cn(
                        "flex items-center justify-between cursor-pointer rounded-md px-3 py-1.5 text-sm",
                        idx === highlightIndex
                          ? "bg-accent text-accent-foreground"
                          : "text-popover-foreground hover:bg-accent/50",
                      )}
                    >
                      <span>{m.value}</span>
                      <span className="text-xs text-muted-foreground ml-3">
                        {(m.contextWindow / 1_000).toFixed(0)}k
                      </span>
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
