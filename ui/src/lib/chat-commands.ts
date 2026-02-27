export interface ChatCommandDefinition {
  command: string
  description: string
  acceptsArgument?: boolean
}

const SLASH_PREFIX = "/"

export const REMEMBER_USAGE = "Usage: /remember <fact>"
export const UNKNOWN_ALIAS_MESSAGE = "Unknown alias. Configure aliases in Settings > Runtime > Command Aliases."

export function getSlashAutocompleteQuery(value: string): string | null {
  const trimmed = value.trimStart()
  if (!trimmed.startsWith(SLASH_PREFIX)) return null

  const firstWhitespaceIndex = trimmed.search(/\s/)
  if (firstWhitespaceIndex !== -1) return null

  return trimmed.slice(SLASH_PREFIX.length).toLowerCase()
}

export function filterChatCommands(
  query: string,
  commands: readonly ChatCommandDefinition[],
): ChatCommandDefinition[] {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return [...commands]

  return commands.filter(({ command }) =>
    command.slice(SLASH_PREFIX.length).startsWith(normalizedQuery),
  )
}

export function buildChatCommandInputValue(command: ChatCommandDefinition): string {
  return `${command.command}${command.acceptsArgument ? " " : ""}`
}
