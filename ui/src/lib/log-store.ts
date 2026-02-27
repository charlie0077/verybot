/**
 * Module-level log buffer that persists across page navigations.
 * Populated by GatewayProvider, read by LogsPage via useSyncExternalStore.
 */

export interface LogEvent {
  ts: string
  level: string
  message: string
}

const MAX_ENTRIES = 2_000
const BATCH_MS = 150

let entries: LogEvent[] = []
let pending: LogEvent[] = []
let batchTimer: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<() => void>()

function notify() {
  for (const fn of listeners) fn()
}

function flush() {
  if (pending.length === 0) return
  const next = [...entries, ...pending]
  entries = next.length > MAX_ENTRIES ? next.slice(-MAX_ENTRIES) : next
  pending = []
  batchTimer = null
  notify()
}

/** Push a single log entry (batched — notifies listeners every ~150ms). */
export function pushLogEntry(entry: LogEvent) {
  pending.push(entry)
  if (!batchTimer) batchTimer = setTimeout(flush, BATCH_MS)
}

/** Replace the entire buffer (e.g. on reconnect with server history). */
export function replaceLogEntries(newEntries: LogEvent[]) {
  entries = newEntries.length > MAX_ENTRIES ? newEntries.slice(-MAX_ENTRIES) : [...newEntries]
  pending = []
  if (batchTimer) { clearTimeout(batchTimer); batchTimer = null }
  notify()
}

/** Snapshot for useSyncExternalStore. */
export function getLogSnapshot(): LogEvent[] {
  return entries
}

/** Clear all buffered log entries. */
export function clearLogStore() {
  entries = []
  pending = []
  if (batchTimer) { clearTimeout(batchTimer); batchTimer = null }
  notify()
}

/** Subscribe for useSyncExternalStore. Returns unsubscribe function. */
export function subscribeLogStore(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
