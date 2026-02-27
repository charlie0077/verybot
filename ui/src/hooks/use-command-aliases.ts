import { useCallback, useEffect, useState } from "react"
import type { ChatCommandDefinition } from "@/lib/chat-commands"
import { COMMAND_ALIASES_CHANGED_EVENT } from "@/lib/command-alias-events"

type RpcFn = (method: string, params?: Record<string, unknown>) => Promise<unknown>

interface CommandAliasRecord {
  alias: string
  expansion: string
}

function stripLeadingSlash(value: string): string {
  return value.replace(/^\/+/, "")
}

function toAliasCommand(row: CommandAliasRecord): ChatCommandDefinition {
  const aliasName = stripLeadingSlash(row.alias)
  const expansion = stripLeadingSlash(row.expansion)
  return {
    command: `/${aliasName}`,
    description: expansion,
    acceptsArgument: expansion.includes("{args}"),
  }
}

export function useCommandAliases(rpc: RpcFn): ChatCommandDefinition[] {
  const [commands, setCommands] = useState<ChatCommandDefinition[]>([])

  const load = useCallback(async () => {
    try {
      const result = await rpc("aliases.list") as { aliases?: CommandAliasRecord[] }
      const aliases = Array.isArray(result.aliases) ? result.aliases : []
      const mapped = aliases
        .filter((row) => typeof row.alias === "string" && typeof row.expansion === "string")
        .map(toAliasCommand)
        .sort((a, b) => a.command.localeCompare(b.command))
      setCommands(mapped)
    } catch {
      setCommands([])
    }
  }, [rpc])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (typeof window === "undefined") return

    function handleAliasesChanged() {
      void load()
    }

    window.addEventListener(COMMAND_ALIASES_CHANGED_EVENT, handleAliasesChanged)
    return () => window.removeEventListener(COMMAND_ALIASES_CHANGED_EVENT, handleAliasesChanged)
  }, [load])

  return commands
}
