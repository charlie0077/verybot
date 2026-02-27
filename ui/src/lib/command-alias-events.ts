export const COMMAND_ALIASES_CHANGED_EVENT = "verybot:command-aliases-changed"

export function dispatchCommandAliasesChanged(): void {
  if (typeof window === "undefined") return
  window.dispatchEvent(new Event(COMMAND_ALIASES_CHANGED_EVENT))
}
