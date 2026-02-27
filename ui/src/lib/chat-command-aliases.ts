/** Max chained alias expansions for a single input. */
const MAX_ALIAS_EXPANSION_DEPTH = 5

function splitCommand(value: string): { commandName: string; commandArg: string } {
  const trimmed = value.trim()
  const firstSpaceIndex = trimmed.indexOf(" ")
  const commandName = (firstSpaceIndex === -1 ? trimmed : trimmed.slice(0, firstSpaceIndex)).toLowerCase()
  const commandArg = firstSpaceIndex === -1 ? "" : trimmed.slice(firstSpaceIndex + 1).trim()
  return { commandName, commandArg }
}

function applyAliasExpansion(expansion: string, args: string): string {
  const trimmedExpansion = expansion.trim()
  const trimmedArgs = args.trim()
  if (trimmedExpansion.includes("{args}")) {
    return trimmedExpansion.replaceAll("{args}", trimmedArgs)
  }
  if (!trimmedArgs) return trimmedExpansion
  return `${trimmedExpansion} ${trimmedArgs}`
}

/**
 * Expand slash-command aliases using a plain map (`/r` -> `/remember {args}`).
 * Expansion is iterative with cycle/depth protection.
 */
export function expandCommandAlias(
  input: string,
  aliasMap: Record<string, string>,
): string {
  let current = input.trim()
  if (!current.startsWith("/")) return current

  const seen = new Set<string>()

  for (let depth = 0; depth < MAX_ALIAS_EXPANSION_DEPTH; depth += 1) {
    const { commandName, commandArg } = splitCommand(current)
    const expansion = aliasMap[commandName]
    if (!expansion) break
    if (seen.has(commandName)) break
    seen.add(commandName)
    current = applyAliasExpansion(expansion, commandArg).trim()
    if (!current.startsWith("/")) break
  }

  return current
}
