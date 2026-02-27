import { useCallback } from "react"
import { REMEMBER_USAGE, UNKNOWN_ALIAS_MESSAGE } from "@/lib/chat-commands"
import { expandCommandAlias } from "@/lib/chat-command-aliases"

type RpcFn = (method: string, params?: Record<string, unknown>) => Promise<unknown>

interface CommandAliasRecord {
  alias: string
  expansion: string
}

const BUILTIN_COMMANDS = new Set(["clear", "reset", "stop", "learn", "remember"])

function normalizeCommandToken(token: string): string {
  const trimmed = token.trim().toLowerCase()
  if (!trimmed) return ""
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`
}

function normalizeAliasExpansion(expansion: string): string {
  return expansion.trim()
}

function parseCommand(input: string): { commandName: string; commandArg: string } {
  const trimmed = input.trim()
  const firstSpaceIndex = trimmed.indexOf(" ")
  const commandName = (firstSpaceIndex === -1 ? trimmed : trimmed.slice(0, firstSpaceIndex)).toLowerCase()
  const commandArg = firstSpaceIndex === -1 ? "" : trimmed.slice(firstSpaceIndex + 1).trim()
  return { commandName, commandArg }
}

function resolveBuiltInCommand(input: string): { commandName: string; commandArg: string } | null {
  const { commandName, commandArg } = parseCommand(input)
  const normalizedCommandName = commandName.replace(/^\/+/, "").toLowerCase()
  if (!normalizedCommandName) return null
  if (BUILTIN_COMMANDS.has(normalizedCommandName)) {
    return { commandName: normalizedCommandName, commandArg }
  }
  return null
}

function toAliasMap(aliases: unknown): Record<string, string> {
  if (!Array.isArray(aliases)) return {}

  const next: Record<string, string> = {}
  for (const row of aliases as unknown[]) {
    if (!row || typeof row !== "object") continue
    const alias = (row as Partial<CommandAliasRecord>).alias
    const expansion = (row as Partial<CommandAliasRecord>).expansion
    if (typeof alias !== "string" || typeof expansion !== "string") continue
    const normalizedAlias = normalizeCommandToken(alias)
    const normalizedExpansion = normalizeAliasExpansion(expansion)
    if (!normalizedAlias || !normalizedExpansion) continue
    next[normalizedAlias] = normalizedExpansion
  }
  return next
}

/**
 * Shared slash-command handler for chat and scheduler sessions.
 * Intercepts `/clear`, `/stop`, etc. and calls the appropriate RPC methods.
 */
export function useChatCommands(opts: {
  rpc: RpcFn
  sessionKey: string
  clearMessages: () => void
  addSystemMessage: (text: string) => void
  onSendMessage?: (text: string) => void
  onLearnPendingChange?: (sessionKey: string, pending: boolean) => void
  onStopResponse?: (sessionKey: string) => void
}) {
  const { rpc, sessionKey, clearMessages, addSystemMessage, onSendMessage, onLearnPendingChange, onStopResponse } = opts

  return useCallback(
    async (command: string) => {
      try {
        const trimmed = command.trim()
        let aliasMap: Record<string, string> = {}
        try {
          const aliasResult = await rpc("aliases.list") as { aliases?: CommandAliasRecord[] }
          aliasMap = toAliasMap(aliasResult?.aliases)
        } catch {
          aliasMap = {}
        }
        const { commandName: inputCommandName } = parseCommand(trimmed)
        const normalizedInputCommand = normalizeCommandToken(inputCommandName)
        if (!normalizedInputCommand || !aliasMap[normalizedInputCommand]) {
          addSystemMessage(UNKNOWN_ALIAS_MESSAGE)
          return
        }
        const expanded = expandCommandAlias(trimmed, aliasMap)
        const resolvedCommand = resolveBuiltInCommand(expanded)
        if (!resolvedCommand) {
          if (onSendMessage) {
            onSendMessage(expanded)
            return
          }
          addSystemMessage("Alias expanded to a plain message, but this view cannot send non-command messages.")
          return
        }
        const { commandName: normalizedCommandName, commandArg } = resolvedCommand

        switch (normalizedCommandName) {
          case "clear":
          case "reset":
            await rpc("sessions.clear", { sessionKey })
            clearMessages()
            addSystemMessage("Session cleared.")
            break
          case "stop":
            await rpc("chat.abort", { sessionKey })
            onStopResponse?.(sessionKey)
            addSystemMessage("Stopped.")
            break
          case "learn":
          {
            onLearnPendingChange?.(sessionKey, true)
            try {
              const result = await rpc("chat.learn", {
                sessionKey,
                ...(commandArg ? { topic: commandArg } : {}),
              }) as {
                topic?: string
                extracted?: number
                saved?: number
                savedFacts?: string[]
              }
              const topic = typeof result.topic === "string" ? result.topic : (commandArg || undefined)
              const extracted = typeof result.extracted === "number" ? result.extracted : 0
              const saved = typeof result.saved === "number" ? result.saved : 0
              const savedFacts = Array.isArray(result.savedFacts) ? result.savedFacts : []

              if (extracted === 0) {
                addSystemMessage(
                  topic
                    ? `No learnable facts found about "${topic}" in the current session.`
                    : "No learnable facts found in the current session.",
                )
                break
              }

              const topicSuffix = topic ? ` about "${topic}"` : ""
              if (saved === 0) {
                addSystemMessage(
                  `Found ${extracted} ${pluralize("fact", extracted)}${topicSuffix}, but all were already known.`,
                )
                break
              }

              const summary = `Learned ${saved} ${pluralize("fact", saved)}${topicSuffix}.`
              const lines = savedFacts.length > 0
                ? `${summary}\n${savedFacts.map((fact) => `- ${fact}`).join("\n")}`
                : summary
              addSystemMessage(lines)
            } finally {
              onLearnPendingChange?.(sessionKey, false)
            }
            break
          }
          case "remember": {
            if (!commandArg) {
              addSystemMessage(REMEMBER_USAGE)
              break
            }
            const result = await rpc("chat.remember", { sessionKey, fact: commandArg }) as
              { saved?: boolean; fact?: string }
            const fact = typeof result.fact === "string" ? result.fact : commandArg
            const prefix = result.saved ? "Learned" : "Already known"
            addSystemMessage(`${prefix}: "${fact}"`)
            break
          }
          default:
            addSystemMessage(UNKNOWN_ALIAS_MESSAGE)
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Command failed"
        addSystemMessage(msg)
      }
    },
    [rpc, sessionKey, clearMessages, addSystemMessage, onSendMessage, onLearnPendingChange, onStopResponse],
  )
}

function pluralize(word: string, count: number): string {
  return count === 1 ? word : `${word}s`
}
