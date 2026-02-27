export type SettingsGroupId = "general" | "agent" | "runtime" | "integrations"

export type SettingsGroupLabelKey =
  | "settings.groupGeneral"
  | "settings.groupAgent"
  | "settings.groupRuntime"
  | "settings.groupIntegrations"

export interface SettingsGroup {
  id: SettingsGroupId
  labelKey: SettingsGroupLabelKey
}

export const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  {
    id: "general",
    labelKey: "settings.groupGeneral",
  },
  {
    id: "agent",
    labelKey: "settings.groupAgent",
  },
  {
    id: "runtime",
    labelKey: "settings.groupRuntime",
  },
  {
    id: "integrations",
    labelKey: "settings.groupIntegrations",
  },
] as const

export const DEFAULT_SETTINGS_GROUP: SettingsGroupId = SETTINGS_GROUPS[0].id

export function isSettingsGroupId(value: string | null | undefined): value is SettingsGroupId {
  return SETTINGS_GROUPS.some((group) => group.id === value)
}
