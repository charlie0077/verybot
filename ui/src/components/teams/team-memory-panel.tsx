import { useState, useEffect, useCallback, useRef } from "react"
import { useTranslation } from "react-i18next"
import { SearchIcon, PlusIcon, Trash2Icon, BrainIcon, LoaderIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useGatewayContext } from "@/contexts/gateway-context"
import type { TeamMemory } from "./types"

const DEBOUNCE_MS = 300
const PAGE_SIZE = 50

interface TeamMemoryPanelProps {
  teamId: string
}

export function TeamMemoryPanel({ teamId }: TeamMemoryPanelProps) {
  const { t } = useTranslation()
  const { rpc } = useGatewayContext()

  const [memories, setMemories] = useState<TeamMemory[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState("")
  const [searchResults, setSearchResults] = useState<string[] | null>(null)
  const [newFact, setNewFact] = useState("")
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const fetchMemories = useCallback(() => {
    setLoading(true)
    rpc("teams.memories.list", { teamId, limit: PAGE_SIZE, offset: 0 })
      .then((result) => {
        const r = result as { entries?: TeamMemory[]; total?: number }
        setMemories(r.entries ?? [])
        setTotal(r.total ?? 0)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [rpc, teamId])

  useEffect(() => {
    fetchMemories()
  }, [fetchMemories])

  // Debounced search
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)

    if (!searchQuery.trim()) {
      setSearchResults(null)
      return
    }

    debounceRef.current = setTimeout(() => {
      rpc("teams.memories.search", { teamId, query: searchQuery.trim() })
        .then((result) => {
          const r = result as { facts?: string[] }
          setSearchResults(r.facts ?? [])
        })
        .catch(() => setSearchResults([]))
    }, DEBOUNCE_MS)

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [searchQuery, rpc, teamId])

  async function handleAdd() {
    const trimmed = newFact.trim()
    if (!trimmed || adding) return
    setAdding(true)
    setError(null)
    try {
      await rpc("teams.memories.add", { teamId, fact: trimmed })
      setNewFact("")
      fetchMemories()
    } catch (err) {
      setError(err instanceof Error ? err.message : t("teams.addMemoryFailed"))
    } finally {
      setAdding(false)
    }
  }

  async function handleDelete(id: string) {
    setError(null)
    try {
      await rpc("teams.memories.delete", { id, teamId })
      setMemories((prev) => prev.filter((m) => m.id !== id))
      setTotal((prev) => prev - 1)
    } catch (err) {
      setError(err instanceof Error ? err.message : t("teams.deleteMemoryFailed"))
    }
  }

  const isSearching = searchQuery.trim().length > 0

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-2">
        <BrainIcon className="size-4 text-chart-5" />
        <h2 className="text-base font-semibold text-foreground">{t("teams.memory")}</h2>
        {total > 0 && !isSearching && (
          <span className="text-xs text-muted-foreground">({total})</span>
        )}
      </div>

      {/* Search */}
      <div className="relative">
        <SearchIcon className="absolute left-2.5 top-2 size-3.5 text-muted-foreground" />
        <Input
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={t("teams.searchMemories")}
          className="h-8 pl-8 text-sm"
        />
      </div>

      {/* Add memory */}
      <div className="flex gap-2">
        <Input
          value={newFact}
          onChange={(e) => setNewFact(e.target.value)}
          placeholder={t("teams.addMemoryPlaceholder")}
          className="h-8 text-sm"
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleAdd()
          }}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={!newFact.trim() || adding}
          onClick={() => void handleAdd()}
        >
          {adding ? (
            <LoaderIcon className="size-3.5 animate-spin" />
          ) : (
            <PlusIcon className="size-3.5" />
          )}
        </Button>
      </div>

      {/* Error */}
      {error && (
        <p className="text-sm text-destructive">{error}</p>
      )}

      {/* Results */}
      {loading ? (
        <div className="flex items-center justify-center py-8">
          <LoaderIcon className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : isSearching ? (
        /* Search results */
        searchResults && searchResults.length > 0 ? (
          <ul className="flex flex-col gap-1.5">
            {searchResults.map((fact, i) => (
              <li
                key={i}
                className="rounded-lg bg-card ring-1 ring-foreground/10 px-3 py-2 text-sm text-foreground"
              >
                {fact}
              </li>
            ))}
          </ul>
        ) : searchResults ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {t("teams.noMemoriesFound")}
          </p>
        ) : null
      ) : memories.length > 0 ? (
        /* Memory list */
        <ul className="flex flex-col gap-1.5">
          {memories.map((mem) => (
            <li
              key={mem.id}
              className="group flex items-start justify-between gap-2 rounded-lg bg-card ring-1 ring-foreground/10 px-3 py-2"
            >
              <span className="text-sm text-foreground">{mem.fact}</span>
              <button
                type="button"
                onClick={() => void handleDelete(mem.id)}
                className="mt-0.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
                aria-label={`Delete memory: ${mem.fact}`}
              >
                <Trash2Icon className="size-3.5 text-muted-foreground hover:text-destructive transition-colors" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="py-8 text-center text-sm text-muted-foreground">
          {t("teams.noMemories")}
        </p>
      )}
    </div>
  )
}
