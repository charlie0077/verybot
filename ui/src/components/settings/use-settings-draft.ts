import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { ConnectionStatus } from "@/hooks/use-gateway"
import type { SettingsGroupId } from "./settings-groups"

type RpcFn = (
  method: string,
  params?: Record<string, unknown>,
) => Promise<unknown>

export type SaveState = "idle" | "saving" | "saved" | "error"

const FLATTEN_SKIP_KEYS = new Set(["mcpServers"])
const DEFAULT_SAVE_FEEDBACK_DURATION_MS = 2_000

type FlatConfig = Record<string, unknown>
type DirtyByGroup = Record<SettingsGroupId, number>
type FieldGroupMap = Record<string, SettingsGroupId>

interface UseSettingsDraftOptions {
  rpc: RpcFn
  status: ConnectionStatus
  fieldGroupMap: FieldGroupMap
  saveFeedbackDurationMs?: number
}

interface ConfigGetResult {
  config?: Record<string, unknown>
}

interface ConfigPatchResult {
  config?: Record<string, unknown>
}

interface UseSettingsDraftResult {
  config: FlatConfig
  error: string | null
  dirtyKeys: string[]
  dirtyCount: number
  dirtyByGroup: DirtyByGroup
  hasDirty: boolean
  loading: boolean
  saveState: SaveState
  setField: (key: string, value: unknown) => void
  setMany: (values: Record<string, unknown>) => void
  resetField: (key: string) => void
  resetGroup: (group: SettingsGroupId) => void
  resetAll: () => void
  reload: () => Promise<void>
  save: () => Promise<boolean>
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export function isConfigValueEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true

  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return false
    return left.every((item, index) => isConfigValueEqual(item, right[index]))
  }

  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left)
    const rightKeys = Object.keys(right)
    if (leftKeys.length !== rightKeys.length) return false
    return leftKeys.every((key) => (
      Object.prototype.hasOwnProperty.call(right, key)
      && isConfigValueEqual(left[key], right[key])
    ))
  }

  return false
}

/** Flatten nested config into flat dot-path keys for the UI. */
export function flattenConfig(data: Record<string, unknown>): FlatConfig {
  const flat: FlatConfig = {}

  for (const [key, val] of Object.entries(data)) {
    if (FLATTEN_SKIP_KEYS.has(key)) {
      flat[key] = val
      continue
    }

    if (isPlainObject(val)) {
      for (const [childKey, childVal] of Object.entries(val)) {
        flat[`${key}.${childKey}`] = childVal
      }
      continue
    }

    flat[key] = val
  }

  return flat
}

/** Unflatten dot-path keys back into a nested config. */
export function unflattenConfig(flat: FlatConfig): Record<string, unknown> {
  const nested: Record<string, unknown> = {}

  for (const [key, val] of Object.entries(flat)) {
    const parts = key.split(".")
    if (parts.length === 2) {
      const [parent, child] = parts
      if (!isPlainObject(nested[parent])) {
        nested[parent] = {}
      }
      ;(nested[parent] as Record<string, unknown>)[child] = val
      continue
    }

    nested[key] = val
  }

  return nested
}

function emptyDirtyByGroup(): DirtyByGroup {
  return {
    general: 0,
    agent: 0,
    runtime: 0,
    integrations: 0,
  }
}

export function buildDirtyPatch(config: FlatConfig, dirtyKeys: readonly string[]): FlatConfig {
  const patch: FlatConfig = {}
  for (const key of dirtyKeys) {
    patch[key] = config[key]
  }
  return patch
}

export function deriveDirtyByGroup(
  dirtyKeys: readonly string[],
  fieldGroupMap: FieldGroupMap,
): DirtyByGroup {
  const result = emptyDirtyByGroup()
  for (const key of dirtyKeys) {
    const group = fieldGroupMap[key]
    if (!group) continue
    result[group] += 1
  }
  return result
}

function extractConfigFromResult(
  result: ConfigGetResult | ConfigPatchResult,
  operation: "config.get" | "config.patch",
): Record<string, unknown> {
  const data = result.config
  if (!isPlainObject(data)) {
    throw new Error(`Unexpected ${operation} response: missing config object`)
  }
  return data
}

export function useSettingsDraft({
  rpc,
  status,
  fieldGroupMap,
  saveFeedbackDurationMs = DEFAULT_SAVE_FEEDBACK_DURATION_MS,
}: UseSettingsDraftOptions): UseSettingsDraftResult {
  const [baseConfig, setBaseConfig] = useState<FlatConfig>({})
  const [draftConfig, setDraftConfig] = useState<FlatConfig>({})
  const [dirtySet, setDirtySet] = useState<Set<string>>(new Set())
  const [saveState, setSaveState] = useState<SaveState>("idle")
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const reloadSeqRef = useRef(0)

  const clearSavedTimer = useCallback(() => {
    clearTimeout(saveTimerRef.current)
  }, [])

  useEffect(() => () => clearSavedTimer(), [clearSavedTimer])

  const applyServerConfig = useCallback((nextConfig: Record<string, unknown>) => {
    const flatConfig = flattenConfig(nextConfig)
    setBaseConfig(flatConfig)
    setDraftConfig(flatConfig)
    setDirtySet(new Set())
    setError(null)
  }, [])

  const reload = useCallback(async () => {
    if (status !== "connected") return

    const seq = ++reloadSeqRef.current
    setLoading(true)
    try {
      const result = await rpc("config.get") as ConfigGetResult
      if (seq !== reloadSeqRef.current) return
      const data = extractConfigFromResult(result, "config.get")
      applyServerConfig(data)
    } catch (err) {
      if (seq !== reloadSeqRef.current) return
      setError(err instanceof Error ? err.message : "Failed to load config")
    } finally {
      if (seq !== reloadSeqRef.current) return
      setLoading(false)
    }
  }, [applyServerConfig, rpc, status])

  useEffect(() => {
    void reload()
  }, [reload])

  const setMany = useCallback((values: Record<string, unknown>) => {
    const entries = Object.entries(values)
    if (entries.length === 0) return

    setDraftConfig((prev) => {
      const next = { ...prev }
      for (const [key, value] of entries) {
        next[key] = value
      }
      return next
    })

    setDirtySet((prev) => {
      const next = new Set(prev)
      for (const [key, value] of entries) {
        if (isConfigValueEqual(value, baseConfig[key])) {
          next.delete(key)
        } else {
          next.add(key)
        }
      }
      return next
    })

    clearSavedTimer()
    setSaveState("idle")
  }, [baseConfig, clearSavedTimer])

  const setField = useCallback((key: string, value: unknown) => {
    setMany({ [key]: value })
  }, [setMany])

  const resetField = useCallback((key: string) => {
    setDraftConfig((prev) => ({ ...prev, [key]: baseConfig[key] }))
    setDirtySet((prev) => {
      const next = new Set(prev)
      next.delete(key)
      return next
    })
    clearSavedTimer()
    setSaveState("idle")
  }, [baseConfig, clearSavedTimer])

  const resetGroup = useCallback((group: SettingsGroupId) => {
    const keys = Array.from(dirtySet).filter((key) => fieldGroupMap[key] === group)
    if (keys.length === 0) return

    setDraftConfig((prev) => {
      const next = { ...prev }
      for (const key of keys) {
        next[key] = baseConfig[key]
      }
      return next
    })

    setDirtySet((prev) => {
      const next = new Set(prev)
      for (const key of keys) {
        next.delete(key)
      }
      return next
    })

    clearSavedTimer()
    setSaveState("idle")
  }, [baseConfig, clearSavedTimer, dirtySet, fieldGroupMap])

  const resetAll = useCallback(() => {
    setDraftConfig(baseConfig)
    setDirtySet(new Set())
    clearSavedTimer()
    setSaveState("idle")
    setError(null)
  }, [baseConfig, clearSavedTimer])

  const save = useCallback(async () => {
    if (dirtySet.size === 0) return true

    setSaveState("saving")
    setError(null)

    const dirtyKeys = Array.from(dirtySet)
    const patch = unflattenConfig(buildDirtyPatch(draftConfig, dirtyKeys))

    try {
      const result = await rpc("config.patch", { patch }) as ConfigPatchResult
      const data = extractConfigFromResult(result, "config.patch")
      applyServerConfig(data)
      setSaveState("saved")
      clearSavedTimer()
      saveTimerRef.current = setTimeout(() => setSaveState("idle"), saveFeedbackDurationMs)
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed")
      setSaveState("error")
      return false
    }
  }, [applyServerConfig, clearSavedTimer, dirtySet, draftConfig, rpc, saveFeedbackDurationMs])

  const dirtyKeys = useMemo(() => Array.from(dirtySet), [dirtySet])
  const dirtyByGroup = useMemo(
    () => deriveDirtyByGroup(dirtyKeys, fieldGroupMap),
    [dirtyKeys, fieldGroupMap],
  )
  const dirtyCount = dirtyKeys.length
  const hasDirty = dirtyCount > 0

  return {
    config: draftConfig,
    error,
    dirtyKeys,
    dirtyCount,
    dirtyByGroup,
    hasDirty,
    loading,
    saveState,
    setField,
    setMany,
    resetField,
    resetGroup,
    resetAll,
    reload,
    save,
  }
}
