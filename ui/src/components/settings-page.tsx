import { useState, useEffect, useCallback } from "react"
import { useTranslation } from "react-i18next"
import {
  ArrowLeftIcon,
  ChevronRightIcon,
  SaveIcon,
  LoaderIcon,
  CheckIcon,
  AlertCircleIcon,
  WifiOffIcon,
  RotateCcwIcon,
  LogOutIcon,
  PlugIcon,
} from "lucide-react"
import { useBeforeUnload, useBlocker, useSearchParams, type BlockerFunction } from "react-router"
import { useGatewayContext } from "@/contexts/gateway-context"
import { useLocalStorage, useMediaQuery } from "usehooks-ts"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { MaskedInput } from "@/components/ui/masked-input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ModelPicker, useModelCatalog, lookupContextWindow } from "@/components/model-picker"
import {
  getCodexReasoningLevel,
  setCodexReasoningLevel,
  supportsCodexReasoningLevel,
  type CodexReasoningLevel,
} from "@/lib/model-spec"
import {
  CODEX_REASONING_LEVELS,
  getCodexReasoningDescriptionKey,
  getCodexReasoningLabelKey,
} from "@/lib/codex-reasoning-labels"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { cn } from "@/lib/utils"
import {
  DEFAULT_SETTINGS_GROUP,
  isSettingsGroupId,
  SETTINGS_GROUPS,
  type SettingsGroupId,
} from "@/components/settings/settings-groups"
import {
  useSettingsDraft,
  type SaveState,
} from "@/components/settings/use-settings-draft"
import { dispatchCommandAliasesChanged } from "@/lib/command-alias-events"

type RpcFn = (method: string, params?: Record<string, unknown>) => Promise<unknown>

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const BASH_SECURITY_OPTIONS = ["deny", "allowlist", "full"] as const
const TTS_REPLY_OPTIONS = ["text", "voice", "inbound"] as const
const BROWSER_MODE_OPTIONS = [
  "per-tab-per-session",
  "per-browser-per-session",
  "shared",
] as const
const MS_PER_SECOND = 1_000
const DARK_MODE_KEY = "verybot-dark-mode"
const LANGUAGE_KEY = "verybot-language"
const LANGUAGES = [
  { value: "en", label: "English" },
  { value: "zh", label: "中文" },
] as const

import {
  FONT_SIZE_KEY,
  DEFAULT_FONT_SIZE,
  FONT_SIZE_OPTIONS,
  validFontSize,
  type FontSizeOption,
} from "@/lib/font-size"

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Get a string value from config with a fallback. */
function str(val: unknown, fallback = ""): string {
  return typeof val === "string" ? val : fallback
}

/** Get a boolean value from config with a fallback. */
function bool(val: unknown, fallback = false): boolean {
  return typeof val === "boolean" ? val : fallback
}

/** Get a number value from config with a fallback. */
function num(val: unknown, fallback = 0): number {
  const n = Number(val)
  return Number.isFinite(n) ? n : fallback
}

/** Parse comma-separated string to array. */
function csvToArray(val: unknown): string[] {
  if (Array.isArray(val)) return val
  if (typeof val === "string") return val.split(",").map((s) => s.trim()).filter(Boolean)
  return []
}

/** Array to comma-separated string. */
function arrayToCsv(arr: unknown): string {
  if (Array.isArray(arr)) return arr.join(", ")
  return ""
}

/** Validate JSON string — returns true if parseable as a plain object. */
function isValidJsonObject(text: string): boolean {
  try {
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
  } catch {
    return false
  }
}

function normalizeAliasInput(rawAlias: string): string {
  const trimmed = rawAlias.trim().toLowerCase()
  if (!trimmed) return ""
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`
}

function normalizeExpansionInput(rawExpansion: string): string {
  return rawExpansion.trim().replace(/^\/+/, "")
}

function stripLeadingSlash(value: string): string {
  return value.replace(/^\/+/, "")
}

/* ------------------------------------------------------------------ */
/*  Sub-components                                                     */
/* ------------------------------------------------------------------ */

interface FieldRowProps {
  label: string
  htmlFor?: string
  children: React.ReactNode
}

function FieldRow({ label, htmlFor, children }: FieldRowProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={htmlFor} className="text-sm font-medium text-foreground">
        {label}
      </Label>
      {children}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Section definitions                                                */
/* ------------------------------------------------------------------ */

interface SectionProps {
  config: Record<string, unknown>
  onChange: (key: string, val: unknown) => void
}

interface CommandAliasRecord {
  alias: string
  expansion: string
}
const SETTINGS_TAB_ID_PREFIX = "settings-tab"
const SETTINGS_PANEL_ID_PREFIX = "settings-panel"
const MOBILE_BREAKPOINT_QUERY = "(min-width: 768px)"

function getSettingsTabId(group: SettingsGroupId): string {
  return `${SETTINGS_TAB_ID_PREFIX}-${group}`
}

function getSettingsPanelId(group: SettingsGroupId): string {
  return `${SETTINGS_PANEL_ID_PREFIX}-${group}`
}

function isExpectedRestartDisconnectError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.message === "WebSocket closed" || error.message === "Not connected"
}

/** Backend config fields that participate in shared dirty tracking. */
const FIELD_GROUP_MAP: Record<string, SettingsGroupId> = {
  model: "agent",
  contextWindow: "agent",
  maxSteps: "agent",
  browserMode: "agent",
  browserHeadless: "agent",
  browserUserAgent: "agent",
  language: "agent",
  identity: "agent",
  "desktop.enabled": "agent",
  "memory.enabled": "agent",
  "memory.maxResults": "agent",
  "tts.enabled": "agent",
  "tts.voice": "agent",
  "tts.replyMode": "agent",
  "bash.security": "runtime",
  "bash.safeBins": "runtime",
  "bash.allowlist": "runtime",
  "sandbox.enabled": "runtime",
  "sandbox.image": "runtime",
  "sandbox.memoryLimit": "runtime",
  "sandbox.pidsLimit": "runtime",
  "sandbox.idleTimeoutMs": "runtime",
  mcpServers: "runtime",
  ANTHROPIC_API_KEY: "integrations",
  OPENAI_API_KEY: "integrations",
  GOOGLE_GENERATIVE_AI_API_KEY: "integrations",
  XAI_API_KEY: "integrations",
  DEEPSEEK_API_KEY: "integrations",
  OPENROUTER_API_KEY: "integrations",
  MINIMAX_API_KEY: "integrations",
  ZHIPU_API_KEY: "integrations",
  TELEGRAM_BOT_TOKEN: "integrations",
  DISCORD_BOT_TOKEN: "integrations",
  SLACK_BOT_TOKEN: "integrations",
  SLACK_APP_TOKEN: "integrations",
  TWITTER_BEARER_TOKEN: "integrations",
  TWITTER_API_KEY: "integrations",
  TWITTER_API_SECRET: "integrations",
  TWITTER_ACCESS_TOKEN: "integrations",
  TWITTER_ACCESS_SECRET: "integrations",
  GITHUB_TOKEN: "integrations",
  GITHUB_DEFAULT_OWNER: "integrations",
}

function GatewayConnectionSection() {
  const { t } = useTranslation()
  const { status, token, setToken, disconnect } = useGatewayContext()
  const [draft, setDraft] = useState(token ?? "")

  // Sync draft when token changes externally
  useEffect(() => { setDraft(token ?? "") }, [token])

  const handleReconnect = () => {
    const trimmed = draft.trim()
    if (trimmed) setToken(trimmed)
  }

  return (
    <SectionCard title={t("settings.gatewayConnection")}>
      <FieldRow label={t("settings.connectionToken")} htmlFor="connection-token">
        <MaskedInput
          id="connection-token"
          value={draft}
          onValueChange={setDraft}
          placeholder={t("login.tokenPlaceholder")}
        />
      </FieldRow>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm">
          <span
            className={`inline-block h-2 w-2 rounded-full ${
              status === "connected"
                ? "bg-green-500"
                : status === "connecting"
                  ? "bg-yellow-500 animate-pulse"
                  : "bg-muted-foreground"
            }`}
          />
          <span className="text-muted-foreground">
            {status === "connected"
              ? t("settings.statusConnected")
              : status === "connecting"
                ? t("common.connecting")
                : t("common.disconnected")}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleReconnect}>
            <PlugIcon className="mr-1.5 h-4 w-4" />
            {t("settings.reconnect")}
          </Button>
          <Button variant="outline" size="sm" onClick={disconnect}>
            <LogOutIcon className="mr-1.5 h-4 w-4" />
            {t("settings.disconnect")}
          </Button>
        </div>
      </div>
    </SectionCard>
  )
}

function AppearanceSection() {
  const { t, i18n } = useTranslation()

  const [darkMode, setDarkMode] = useState(() => {
    const stored = localStorage.getItem(DARK_MODE_KEY)
    if (stored !== null) return stored === "true"
    return window.matchMedia("(prefers-color-scheme: dark)").matches
  })

  const [language, setLanguage] = useState(
    () => localStorage.getItem(LANGUAGE_KEY) ?? "en",
  )

  const [fontSize, setFontSize] = useLocalStorage<FontSizeOption>(FONT_SIZE_KEY, DEFAULT_FONT_SIZE)

  const toggleDarkMode = (checked: boolean) => {
    setDarkMode(checked)
    localStorage.setItem(DARK_MODE_KEY, String(checked))
    document.documentElement.classList.toggle("dark", checked)
  }

  const changeLanguage = (val: string) => {
    setLanguage(val)
    localStorage.setItem(LANGUAGE_KEY, val)
    void i18n.changeLanguage(val)
  }

  const changeFontSize = (val: string) => {
    setFontSize(validFontSize(val))
  }

  return (
    <SectionCard title={t("settings.appearance")}>
      <ToggleRow
        label={t("settings.darkMode")}
        checked={darkMode}
        onCheckedChange={toggleDarkMode}
      />
      <FieldRow label={t("settings.language")}>
        <Select value={language} onValueChange={changeLanguage}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LANGUAGES.map((lang) => (
              <SelectItem key={lang.value} value={lang.value}>
                {lang.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldRow>
      <FieldRow label={t("settings.chatFontSize")}>
        <Select value={fontSize} onValueChange={changeFontSize}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FONT_SIZE_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {t(opt.labelKey)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldRow>
    </SectionCard>
  )
}

function ModelSection({ config, onChange }: SectionProps) {
  const { t } = useTranslation()
  const catalog = useModelCatalog()
  const currentModel = str(config.model)
  const codexReasoning = getCodexReasoningLevel(currentModel) ?? "medium"
  const catalogCtx = lookupContextWindow(catalog, currentModel)
  const isCustomModel = catalogCtx === 0
  const configCtx = num(config.contextWindow, 0)

  return (
    <SectionCard title={t("settings.model")}>
      <FieldRow label={t("settings.model")} htmlFor="model">
        <ModelPicker
          value={currentModel}
          onValueChange={(v) => {
            onChange("model", v)
            if (lookupContextWindow(catalog, v) > 0) onChange("contextWindow", 0)
          }}
        />
      </FieldRow>
      {supportsCodexReasoningLevel(currentModel) && (
        <FieldRow label={t("settings.codexReasoningLevel")}>
          <Select
            value={codexReasoning}
            onValueChange={(v) => onChange("model", setCodexReasoningLevel(currentModel, v as CodexReasoningLevel))}
          >
            <SelectTrigger className="w-full">
              <SelectValue>{t(getCodexReasoningLabelKey("settings", codexReasoning))}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {CODEX_REASONING_LEVELS.map((level) => (
                <SelectItem key={level} value={level}>
                  {t(getCodexReasoningLabelKey("settings", level))}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {t(getCodexReasoningDescriptionKey("settings", codexReasoning))}
          </p>
        </FieldRow>
      )}
      <FieldRow label={t("settings.contextWindow")} htmlFor="contextWindow">
        <Input
          id="contextWindow"
          type="number"
          min={1024}
          disabled={!isCustomModel}
          value={isCustomModel ? String(configCtx || "") : String(catalogCtx)}
          onChange={(e) => onChange("contextWindow", Number(e.target.value) || 0)}
          placeholder="128000"
        />
        {!isCustomModel && (
          <p className="text-xs text-muted-foreground">
            {t("settings.contextWindowCatalog", { count: catalogCtx })}
          </p>
        )}
        {isCustomModel && (
          <p className="text-xs text-muted-foreground">
            {t("settings.contextWindowCustom")}
          </p>
        )}
      </FieldRow>
      <FieldRow label={t("settings.maxSteps")} htmlFor="maxSteps">
        <Input
          id="maxSteps"
          type="number"
          min={1}
          max={100}
          value={String(num(config.maxSteps, 20))}
          onChange={(e) => onChange("maxSteps", Number(e.target.value))}
        />
      </FieldRow>
    </SectionCard>
  )
}

function BrowserSection({ config, onChange }: SectionProps) {
  const { t } = useTranslation()
  const browserMode = str(config.browserMode, "per-tab-per-session")
  return (
    <SectionCard title={t("settings.browser")}>
      <FieldRow label={t("settings.browserMode")}>
        <Select
          value={browserMode}
          onValueChange={(v) => onChange("browserMode", v)}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {BROWSER_MODE_OPTIONS.map((mode) => (
              <SelectItem key={mode} value={mode}>
                {t(`settings.browserModeOptions.${mode}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          {t(`settings.browserModeHelp.${browserMode}`, {
            defaultValue: t("settings.browserModeHelp.per-tab-per-session"),
          })}
        </p>
      </FieldRow>
      <ToggleRow
        label={t("settings.headless")}
        checked={bool(config.browserHeadless, true)}
        onCheckedChange={(v) => onChange("browserHeadless", v)}
      />
      <FieldRow label={t("settings.userAgent")} htmlFor="browserUserAgent">
        <Input
          id="browserUserAgent"
          value={str(config.browserUserAgent)}
          onChange={(e) => onChange("browserUserAgent", e.target.value)}
          placeholder={t("settings.userAgentPlaceholder")}
        />
      </FieldRow>
    </SectionCard>
  )
}

function AgentSection({ config, onChange }: SectionProps) {
  const { t } = useTranslation()
  return (
    <SectionCard title={t("settings.agentSection")}>
      <FieldRow label={t("settings.agentLanguage")} htmlFor="language">
        <Input
          id="language"
          value={str(config.language, "auto")}
          onChange={(e) => onChange("language", e.target.value)}
          placeholder="auto"
        />
      </FieldRow>
      <FieldRow label={t("settings.identity")} htmlFor="identity">
        <Textarea
          id="identity"
          value={str(config.identity)}
          onChange={(e) => onChange("identity", e.target.value)}
          rows={4}
        />
      </FieldRow>
    </SectionCard>
  )
}


function SecuritySection({ config, onChange }: SectionProps) {
  const { t } = useTranslation()
  return (
    <SectionCard title={t("settings.security")}>
      <FieldRow label={t("settings.bashSecurityMode")}>
        <Select
          value={str(config["bash.security"], "full")}
          onValueChange={(v) => onChange("bash.security", v)}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {BASH_SECURITY_OPTIONS.map((o) => (
              <SelectItem key={o} value={o}>{o}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldRow>
      <FieldRow label={t("settings.safeBins")} htmlFor="bash.safeBins">
        <Input
          id="bash.safeBins"
          value={arrayToCsv(config["bash.safeBins"])}
          onChange={(e) => onChange("bash.safeBins", csvToArray(e.target.value))}
        />
      </FieldRow>
      <FieldRow label={t("settings.allowlist")} htmlFor="bash.allowlist">
        <Input
          id="bash.allowlist"
          value={arrayToCsv(config["bash.allowlist"])}
          onChange={(e) => onChange("bash.allowlist", csvToArray(e.target.value))}
        />
      </FieldRow>
    </SectionCard>
  )
}

function SandboxSection({ config, onChange }: SectionProps) {
  const { t } = useTranslation()
  return (
    <SectionCard title={t("settings.sandbox")}>
      <ToggleRow
        label={t("common.enabled")}
        checked={bool(config["sandbox.enabled"])}
        onCheckedChange={(v) => onChange("sandbox.enabled", v)}
      />
      <FieldRow label={t("settings.sandboxImage")} htmlFor="sandbox.image">
        <Input
          id="sandbox.image"
          value={str(config["sandbox.image"], "ubuntu:24.04")}
          onChange={(e) => onChange("sandbox.image", e.target.value)}
        />
      </FieldRow>
      <FieldRow label={t("settings.sandboxMemoryLimit")} htmlFor="sandbox.memoryLimit">
        <Input
          id="sandbox.memoryLimit"
          value={str(config["sandbox.memoryLimit"], "256m")}
          onChange={(e) => onChange("sandbox.memoryLimit", e.target.value)}
        />
      </FieldRow>
      <FieldRow label={t("settings.sandboxPidsLimit")} htmlFor="sandbox.pidsLimit">
        <Input
          id="sandbox.pidsLimit"
          type="number"
          min={1}
          value={String(num(config["sandbox.pidsLimit"], 64))}
          onChange={(e) => onChange("sandbox.pidsLimit", Number(e.target.value))}
        />
      </FieldRow>
      <FieldRow label={t("settings.sandboxIdleTimeout")} htmlFor="sandbox.idleTimeoutMs">
        <Input
          id="sandbox.idleTimeoutMs"
          type="number"
          min={0}
          value={String(Math.round(num(config["sandbox.idleTimeoutMs"], 300_000) / MS_PER_SECOND))}
          onChange={(e) => onChange("sandbox.idleTimeoutMs", Number(e.target.value) * MS_PER_SECOND)}
        />
      </FieldRow>
    </SectionCard>
  )
}

function DesktopSection({ config, onChange }: SectionProps) {
  const { t } = useTranslation()
  return (
    <SectionCard title={t("settings.desktop")}>
      <ToggleRow
        label={t("common.enabled")}
        checked={bool(config["desktop.enabled"])}
        onCheckedChange={(v) => onChange("desktop.enabled", v)}
      />
    </SectionCard>
  )
}

function MemorySection({ config, onChange }: SectionProps) {
  const { t } = useTranslation()
  return (
    <SectionCard title={t("settings.memory")}>
      <ToggleRow
        label={t("common.enabled")}
        checked={bool(config["memory.enabled"], true)}
        onCheckedChange={(v) => onChange("memory.enabled", v)}
      />
      <FieldRow label={t("settings.memoryMaxResults")} htmlFor="memory.maxResults">
        <Input
          id="memory.maxResults"
          type="number"
          min={1}
          max={50}
          value={String(num(config["memory.maxResults"], 5))}
          onChange={(e) => onChange("memory.maxResults", Number(e.target.value))}
        />
      </FieldRow>
    </SectionCard>
  )
}

function VoiceSection({ config, onChange }: SectionProps) {
  const { t } = useTranslation()
  return (
    <SectionCard title={t("settings.voice")}>
      <ToggleRow
        label={t("common.enabled")}
        checked={bool(config["tts.enabled"], true)}
        onCheckedChange={(v) => onChange("tts.enabled", v)}
      />
      <FieldRow label={t("settings.voiceName")} htmlFor="tts.voice">
        <Input
          id="tts.voice"
          value={str(config["tts.voice"])}
          onChange={(e) => onChange("tts.voice", e.target.value)}
        />
      </FieldRow>
      <FieldRow label={t("settings.voiceReplyMode")}>
        <Select
          value={str(config["tts.replyMode"], "inbound")}
          onValueChange={(v) => onChange("tts.replyMode", v)}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TTS_REPLY_OPTIONS.map((o) => (
              <SelectItem key={o} value={o}>{o}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldRow>
    </SectionCard>
  )
}

function McpSection({ config, onChange }: SectionProps) {
  const { t } = useTranslation()
  const raw = config.mcpServers
  const [draft, setDraft] = useState("")
  const [jsonError, setJsonError] = useState(false)

  useEffect(() => {
    const text = typeof raw === "string" ? raw : JSON.stringify(raw ?? {}, null, 2)
    setDraft(text)
    setJsonError(false)
  }, [raw])

  const handleDraftChange = (text: string) => {
    setDraft(text)
    if (isValidJsonObject(text)) {
      setJsonError(false)
      onChange("mcpServers", JSON.parse(text))
    } else {
      setJsonError(true)
    }
  }

  return (
    <SectionCard title={t("settings.mcpServers")}>
      <FieldRow label={t("settings.mcpServersJson")} htmlFor="mcpServers">
        <Textarea
          id="mcpServers"
          value={draft}
          onChange={(e) => handleDraftChange(e.target.value)}
          rows={6}
          className="font-mono text-xs"
          aria-invalid={jsonError}
        />
        {jsonError && (
          <p className="text-sm text-destructive">{t("settings.invalidJson")}</p>
        )}
      </FieldRow>
    </SectionCard>
  )
}

function CommandAliasesSection({ rpc }: { rpc: RpcFn }) {
  const { t } = useTranslation()
  const [aliases, setAliases] = useState<CommandAliasRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [deletingAlias, setDeletingAlias] = useState<string | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [editingAlias, setEditingAlias] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [modalAlias, setModalAlias] = useState("")
  const [modalExpansion, setModalExpansion] = useState("")

  const loadAliases = useCallback(async () => {
    try {
      const result = await rpc("aliases.list") as { aliases?: CommandAliasRecord[] }
      const rows = Array.isArray(result.aliases) ? result.aliases : []
      setAliases(
        rows
          .filter((row) => typeof row.alias === "string" && typeof row.expansion === "string")
          .sort((a, b) => a.alias.localeCompare(b.alias)),
      )
      setError(null)
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("settings.aliasesLoadFailed")
      setError(msg)
    } finally {
      setLoading(false)
    }
  }, [rpc, t])

  useEffect(() => {
    void loadAliases()
  }, [loadAliases])

  const openCreateModal = useCallback(() => {
    setEditingAlias(null)
    setModalAlias("")
    setModalExpansion("")
    setError(null)
    setModalOpen(true)
  }, [])

  const openEditModal = useCallback((alias: CommandAliasRecord) => {
    setEditingAlias(alias.alias)
    setModalAlias(stripLeadingSlash(alias.alias))
    setModalExpansion(stripLeadingSlash(alias.expansion))
    setError(null)
    setModalOpen(true)
  }, [])

  const handleSaveAlias = useCallback(async () => {
    const alias = normalizeAliasInput(modalAlias)
    const expansion = normalizeExpansionInput(modalExpansion)
    if (!alias || !expansion) return
    setSaving(true)
    try {
      await rpc("aliases.upsert", { alias, expansion })
      await loadAliases()
      dispatchCommandAliasesChanged()
      setModalOpen(false)
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("settings.aliasesSaveFailed")
      setError(msg)
    } finally {
      setSaving(false)
    }
  }, [loadAliases, modalAlias, modalExpansion, rpc, t])

  const handleDeleteAlias = useCallback(async (alias: string) => {
    setDeletingAlias(alias)
    try {
      await rpc("aliases.delete", { alias })
      await loadAliases()
      dispatchCommandAliasesChanged()
      if (editingAlias === alias) {
        setModalOpen(false)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("settings.aliasesDeleteFailed")
      setError(msg)
    } finally {
      setDeletingAlias(null)
    }
  }, [editingAlias, loadAliases, rpc, t])

  return (
    <SectionCard title={t("settings.commandAliases")}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs text-muted-foreground">{t("settings.commandAliasesHelp")}</p>
        <Button type="button" size="sm" onClick={openCreateModal}>
          {t("settings.addAlias")}
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {loading ? (
        <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
      ) : aliases.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("settings.aliasesEmpty")}</p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {aliases.map((alias) => (
            <Card
              key={alias.alias}
              size="sm"
              interactive
              asChild
            >
              <button
                type="button"
                className="text-left"
                onClick={() => openEditModal(alias)}
              >
                <CardContent className="flex flex-col gap-1.5 py-2">
                  <code className="text-sm font-semibold text-foreground">{stripLeadingSlash(alias.alias)}</code>
                  <p className="max-h-14 overflow-hidden text-xs text-muted-foreground whitespace-pre-wrap break-words">
                    {stripLeadingSlash(alias.expansion)}
                  </p>
                </CardContent>
              </button>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{editingAlias ? t("settings.editAlias") : t("settings.addAlias")}</DialogTitle>
            <DialogDescription>{t("settings.commandAliasModalHelp")}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <FieldRow label={t("settings.aliasName")} htmlFor="command-alias-modal-name">
              <Input
                id="command-alias-modal-name"
                value={modalAlias}
                onChange={(e) => setModalAlias(e.target.value)}
                placeholder={t("settings.aliasNamePlaceholder")}
              />
            </FieldRow>
            <FieldRow label={t("settings.aliasExpansion")} htmlFor="command-alias-modal-expansion">
              <Textarea
                id="command-alias-modal-expansion"
                value={modalExpansion}
                onChange={(e) => setModalExpansion(e.target.value)}
                placeholder={t("settings.aliasExpansionPlaceholder")}
                rows={8}
              />
            </FieldRow>
          </div>
          <DialogFooter>
            {editingAlias && (
              <Button
                type="button"
                variant="destructive"
                disabled={deletingAlias === editingAlias}
                onClick={() => handleDeleteAlias(editingAlias)}
              >
                {t("settings.deleteAlias")}
              </Button>
            )}
            <Button type="button" variant="outline" onClick={() => setModalOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              disabled={saving || modalAlias.trim().length === 0 || modalExpansion.trim().length === 0}
              onClick={handleSaveAlias}
            >
              {t("settings.saveAlias")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SectionCard>
  )
}

function ApiKeysSection({ config, onChange }: SectionProps) {
  const { t } = useTranslation()
  return (
    <SectionCard title={t("settings.apiKeys")}>
      <FieldRow label={t("settings.anthropicApiKey")} htmlFor="ANTHROPIC_API_KEY">
        <MaskedInput
          id="ANTHROPIC_API_KEY"
          value={str(config.ANTHROPIC_API_KEY)}
          onValueChange={(v) => onChange("ANTHROPIC_API_KEY", v)}
          placeholder="sk-ant-..."
        />
      </FieldRow>
      <FieldRow label={t("settings.openaiApiKey")} htmlFor="OPENAI_API_KEY">
        <MaskedInput
          id="OPENAI_API_KEY"
          value={str(config.OPENAI_API_KEY)}
          onValueChange={(v) => onChange("OPENAI_API_KEY", v)}
          placeholder="sk-..."
        />
      </FieldRow>
      <FieldRow label={t("settings.googleApiKey")} htmlFor="GOOGLE_GENERATIVE_AI_API_KEY">
        <MaskedInput
          id="GOOGLE_GENERATIVE_AI_API_KEY"
          value={str(config.GOOGLE_GENERATIVE_AI_API_KEY)}
          onValueChange={(v) => onChange("GOOGLE_GENERATIVE_AI_API_KEY", v)}
        />
      </FieldRow>
      <FieldRow label={t("settings.xaiApiKey")} htmlFor="XAI_API_KEY">
        <MaskedInput
          id="XAI_API_KEY"
          value={str(config.XAI_API_KEY)}
          onValueChange={(v) => onChange("XAI_API_KEY", v)}
        />
      </FieldRow>
      <FieldRow label={t("settings.deepseekApiKey")} htmlFor="DEEPSEEK_API_KEY">
        <MaskedInput
          id="DEEPSEEK_API_KEY"
          value={str(config.DEEPSEEK_API_KEY)}
          onValueChange={(v) => onChange("DEEPSEEK_API_KEY", v)}
        />
      </FieldRow>
      <FieldRow label={t("settings.openrouterApiKey")} htmlFor="OPENROUTER_API_KEY">
        <MaskedInput
          id="OPENROUTER_API_KEY"
          value={str(config.OPENROUTER_API_KEY)}
          onValueChange={(v) => onChange("OPENROUTER_API_KEY", v)}
        />
      </FieldRow>
      <FieldRow label={t("settings.minimaxApiKey")} htmlFor="MINIMAX_API_KEY">
        <MaskedInput
          id="MINIMAX_API_KEY"
          value={str(config.MINIMAX_API_KEY)}
          onValueChange={(v) => onChange("MINIMAX_API_KEY", v)}
        />
      </FieldRow>
      <FieldRow label={t("settings.zhipuApiKey")} htmlFor="ZHIPU_API_KEY">
        <MaskedInput
          id="ZHIPU_API_KEY"
          value={str(config.ZHIPU_API_KEY)}
          onValueChange={(v) => onChange("ZHIPU_API_KEY", v)}
        />
      </FieldRow>
    </SectionCard>
  )
}

function ChannelsSection({ config, onChange }: SectionProps) {
  const { t } = useTranslation()
  return (
    <SectionCard title={t("settings.channelsSection")}>
      <FieldRow label={t("settings.telegramBotToken")} htmlFor="TELEGRAM_BOT_TOKEN">
        <MaskedInput
          id="TELEGRAM_BOT_TOKEN"
          value={str(config.TELEGRAM_BOT_TOKEN)}
          onValueChange={(v) => onChange("TELEGRAM_BOT_TOKEN", v)}
        />
      </FieldRow>
      <FieldRow label={t("settings.discordBotToken")} htmlFor="DISCORD_BOT_TOKEN">
        <MaskedInput
          id="DISCORD_BOT_TOKEN"
          value={str(config.DISCORD_BOT_TOKEN)}
          onValueChange={(v) => onChange("DISCORD_BOT_TOKEN", v)}
        />
      </FieldRow>
      <FieldRow label={t("settings.slackBotToken")} htmlFor="SLACK_BOT_TOKEN">
        <MaskedInput
          id="SLACK_BOT_TOKEN"
          value={str(config.SLACK_BOT_TOKEN)}
          onValueChange={(v) => onChange("SLACK_BOT_TOKEN", v)}
        />
      </FieldRow>
      <FieldRow label={t("settings.slackAppToken")} htmlFor="SLACK_APP_TOKEN">
        <MaskedInput
          id="SLACK_APP_TOKEN"
          value={str(config.SLACK_APP_TOKEN)}
          onValueChange={(v) => onChange("SLACK_APP_TOKEN", v)}
        />
      </FieldRow>
    </SectionCard>
  )
}

function TwitterSection({ config, onChange }: SectionProps) {
  const { t } = useTranslation()
  return (
    <SectionCard title={t("settings.twitter")}>
      <FieldRow label={t("settings.twitterBearerToken")} htmlFor="TWITTER_BEARER_TOKEN">
        <MaskedInput
          id="TWITTER_BEARER_TOKEN"
          value={str(config.TWITTER_BEARER_TOKEN)}
          onValueChange={(v) => onChange("TWITTER_BEARER_TOKEN", v)}
        />
      </FieldRow>
      <FieldRow label={t("settings.twitterApiKey")} htmlFor="TWITTER_API_KEY">
        <MaskedInput
          id="TWITTER_API_KEY"
          value={str(config.TWITTER_API_KEY)}
          onValueChange={(v) => onChange("TWITTER_API_KEY", v)}
        />
      </FieldRow>
      <FieldRow label={t("settings.twitterApiSecret")} htmlFor="TWITTER_API_SECRET">
        <MaskedInput
          id="TWITTER_API_SECRET"
          value={str(config.TWITTER_API_SECRET)}
          onValueChange={(v) => onChange("TWITTER_API_SECRET", v)}
        />
      </FieldRow>
      <FieldRow label={t("settings.twitterAccessToken")} htmlFor="TWITTER_ACCESS_TOKEN">
        <MaskedInput
          id="TWITTER_ACCESS_TOKEN"
          value={str(config.TWITTER_ACCESS_TOKEN)}
          onValueChange={(v) => onChange("TWITTER_ACCESS_TOKEN", v)}
        />
      </FieldRow>
      <FieldRow label={t("settings.twitterAccessSecret")} htmlFor="TWITTER_ACCESS_SECRET">
        <MaskedInput
          id="TWITTER_ACCESS_SECRET"
          value={str(config.TWITTER_ACCESS_SECRET)}
          onValueChange={(v) => onChange("TWITTER_ACCESS_SECRET", v)}
        />
      </FieldRow>
    </SectionCard>
  )
}

function GitHubSection({ config, onChange }: SectionProps) {
  const { t } = useTranslation()
  return (
    <SectionCard title={t("settings.github")}>
      <FieldRow label={t("settings.githubToken")} htmlFor="GITHUB_TOKEN">
        <MaskedInput
          id="GITHUB_TOKEN"
          value={str(config.GITHUB_TOKEN)}
          onValueChange={(v) => onChange("GITHUB_TOKEN", v)}
        />
      </FieldRow>
      <FieldRow label={t("settings.githubDefaultOwner")} htmlFor="GITHUB_DEFAULT_OWNER">
        <Input
          id="GITHUB_DEFAULT_OWNER"
          value={str(config.GITHUB_DEFAULT_OWNER)}
          onChange={(e) => onChange("GITHUB_DEFAULT_OWNER", e.target.value)}
        />
      </FieldRow>
    </SectionCard>
  )
}

/* ------------------------------------------------------------------ */
/*  Shared building blocks                                             */
/* ------------------------------------------------------------------ */

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {children}
      </CardContent>
    </Card>
  )
}

interface ToggleRowProps {
  label: string
  checked: boolean
  onCheckedChange: (v: boolean) => void
}

function ToggleRow({ label, checked, onCheckedChange }: ToggleRowProps) {
  return (
    <div className="flex items-center justify-between">
      <Label className="text-sm font-medium text-foreground">{label}</Label>
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  )
}

interface SettingsSubNavProps {
  activeGroup: SettingsGroupId
  dirtyByGroup: Record<SettingsGroupId, number>
  onGroupChange: (group: SettingsGroupId) => void
}

function SettingsSubNav({ activeGroup, dirtyByGroup, onGroupChange }: SettingsSubNavProps) {
  const { t } = useTranslation()

  return (
    <nav
      data-slot="settings-sub-nav"
      className="w-full self-start"
      aria-label={t("settings.groupNav")}
    >
      <Card size="sm">
        <CardHeader>
          <CardTitle>{t("settings.groupNav")}</CardTitle>
        </CardHeader>
        <CardContent
          role="tablist"
          aria-orientation="vertical"
          className="flex flex-col gap-1"
        >
          {SETTINGS_GROUPS.map((group) => {
            const isActive = activeGroup === group.id
            const groupDirtyCount = dirtyByGroup[group.id]
            return (
              <Button
                key={group.id}
                id={getSettingsTabId(group.id)}
                type="button"
                role="tab"
                aria-controls={getSettingsPanelId(group.id)}
                aria-selected={isActive}
                size="sm"
                variant="ghost"
                className={cn(
                  "w-full justify-start rounded-md px-3 py-2 text-sm font-medium whitespace-nowrap",
                  isActive
                    ? "bg-muted text-foreground hover:bg-muted"
                    : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
                )}
                onClick={() => onGroupChange(group.id)}
              >
                <span className="truncate">{t(group.labelKey)}</span>
                {groupDirtyCount > 0 && (
                  <Badge
                    variant={isActive ? "secondary" : "outline"}
                    className="ml-auto"
                  >
                    {groupDirtyCount}
                  </Badge>
                )}
              </Button>
            )
          })}
        </CardContent>
      </Card>
    </nav>
  )
}

interface SettingsGroupPanelProps {
  group: SettingsGroupId
  activeGroup: SettingsGroupId
  children: React.ReactNode
}

function SettingsGroupPanel({ group, activeGroup, children }: SettingsGroupPanelProps) {
  const isActive = group === activeGroup

  return (
    <section
      data-slot={`settings-group-${group}`}
      id={getSettingsPanelId(group)}
      role="tabpanel"
      aria-labelledby={getSettingsTabId(group)}
      hidden={!isActive}
      className="flex flex-col gap-6"
    >
      {children}
    </section>
  )
}

interface SettingsGroupContentProps {
  group: SettingsGroupId
  rpc: RpcFn
  config: Record<string, unknown>
  onChange: (key: string, val: unknown) => void
}

function SettingsGroupContent({ group, rpc, config, onChange }: SettingsGroupContentProps) {
  if (group === "general") {
    return (
      <>
        <GatewayConnectionSection />
        <AppearanceSection />
      </>
    )
  }

  if (group === "agent") {
    return (
      <>
        <ModelSection config={config} onChange={onChange} />
        <BrowserSection config={config} onChange={onChange} />
        <AgentSection config={config} onChange={onChange} />
        <DesktopSection config={config} onChange={onChange} />
        <MemorySection config={config} onChange={onChange} />
        <VoiceSection config={config} onChange={onChange} />
      </>
    )
  }

  if (group === "runtime") {
    return (
      <>
        <SecuritySection config={config} onChange={onChange} />
        <SandboxSection config={config} onChange={onChange} />
        <McpSection config={config} onChange={onChange} />
        <CommandAliasesSection rpc={rpc} />
      </>
    )
  }

  return (
    <>
      <ApiKeysSection config={config} onChange={onChange} />
      <ChannelsSection config={config} onChange={onChange} />
      <TwitterSection config={config} onChange={onChange} />
      <GitHubSection config={config} onChange={onChange} />
    </>
  )
}

interface SettingsMobileGroupListProps {
  activeGroup: SettingsGroupId
  dirtyByGroup: Record<SettingsGroupId, number>
  onOpenGroup: (group: SettingsGroupId) => void
}

function SettingsMobileGroupList({
  activeGroup,
  dirtyByGroup,
  onOpenGroup,
}: SettingsMobileGroupListProps) {
  const { t } = useTranslation()

  return (
    <div className="flex flex-col gap-3">
      {SETTINGS_GROUPS.map((group) => {
        const dirtyCount = dirtyByGroup[group.id]
        const isActive = activeGroup === group.id

        return (
          <Card key={group.id} size="sm" interactive>
            <CardContent className="px-0">
              <Button
                type="button"
                variant="ghost"
                className={cn(
                  "h-auto w-full justify-start gap-3 rounded-none px-4 py-3",
                  isActive ? "text-foreground" : "text-muted-foreground",
                )}
                onClick={() => onOpenGroup(group.id)}
              >
                <span className="text-sm font-medium">{t(group.labelKey)}</span>
                {dirtyCount > 0 && (
                  <Badge variant="secondary" className="ml-auto">
                    {dirtyCount}
                  </Badge>
                )}
                <ChevronRightIcon className={cn("size-4 text-muted-foreground", dirtyCount === 0 && "ml-auto")} />
              </Button>
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Main SettingsPage                                                  */
/* ------------------------------------------------------------------ */

function getSaveButtonIcon(saveState: SaveState): React.ReactNode {
  if (saveState === "saving") {
    return <LoaderIcon className="mr-1.5 h-4 w-4 animate-spin" />
  }

  if (saveState === "saved") {
    return <CheckIcon className="mr-1.5 h-4 w-4" />
  }

  if (saveState === "error") {
    return <AlertCircleIcon className="mr-1.5 h-4 w-4" />
  }

  return <SaveIcon className="mr-1.5 h-4 w-4" />
}

export function SettingsPage() {
  const { t } = useTranslation()
  const { rpc, status } = useGatewayContext()
  const isDesktop = useMediaQuery(MOBILE_BREAKPOINT_QUERY)
  const [searchParams, setSearchParams] = useSearchParams()
  const queryGroupRaw = searchParams.get("group")
  const queryGroup = isSettingsGroupId(queryGroupRaw) ? queryGroupRaw : null
  const activeGroup = queryGroup ?? DEFAULT_SETTINGS_GROUP
  const mobileGroup = queryGroup
  const [restarting, setRestarting] = useState(false)
  const [restartError, setRestartError] = useState<string | null>(null)

  const {
    config,
    dirtyByGroup,
    hasDirty,
    loading,
    saveState,
    error: draftError,
    setField,
    save,
  } = useSettingsDraft({
    rpc,
    status,
    fieldGroupMap: FIELD_GROUP_MAP,
  })

  const shouldBlockNavigation = useCallback<BlockerFunction>(({ currentLocation, nextLocation }) => {
    if (!hasDirty) return false
    return currentLocation.pathname !== nextLocation.pathname
  }, [hasDirty])

  const blocker = useBlocker(shouldBlockNavigation)

  useEffect(() => {
    if (blocker.state !== "blocked") return
    const shouldProceed = window.confirm(t("settings.unsavedChangesPrompt"))
    if (shouldProceed) {
      blocker.proceed()
      return
    }
    blocker.reset()
  }, [blocker, t])

  useBeforeUnload(useCallback((event) => {
    if (!hasDirty) return
    event.preventDefault()
    event.returnValue = t("settings.unsavedChangesPrompt")
  }, [hasDirty, t]))

  const updateGroupSearchParam = useCallback((group: SettingsGroupId | null) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      if (group) {
        next.set("group", group)
      } else {
        next.delete("group")
      }
      return next
    }, { replace: true })
  }, [setSearchParams])

  const handleGroupChange = useCallback((group: SettingsGroupId) => {
    updateGroupSearchParam(group)
  }, [updateGroupSearchParam])

  const handleMobileGroupOpen = useCallback((group: SettingsGroupId) => {
    updateGroupSearchParam(group)
  }, [updateGroupSearchParam])

  const handleMobileBack = useCallback(() => {
    updateGroupSearchParam(null)
  }, [updateGroupSearchParam])

  const handleSave = useCallback(async () => {
    await save()
  }, [save])

  const handleRestart = useCallback(async () => {
    setRestarting(true)
    setRestartError(null)
    try {
      await rpc("system.restart")
    } catch (err) {
      if (isExpectedRestartDisconnectError(err)) {
        return
      }
      if (err instanceof Error && err.message) {
        setRestartError(err.message)
      }
    }
  }, [rpc])

  useEffect(() => {
    if (restarting && status === "connected") setRestarting(false)
  }, [restarting, status])

  const mergedError = draftError ?? restartError

  if (status !== "connected") {
    return (
      <div data-slot="settings-page" className="flex h-full items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <WifiOffIcon className="h-8 w-8" />
          <p className="text-sm">
            {status === "connecting" ? t("common.connecting") : t("common.disconnected")}
          </p>
        </div>
      </div>
    )
  }

  const mobileGroupTitle = mobileGroup
    ? t(SETTINGS_GROUPS.find((group) => group.id === mobileGroup)?.labelKey ?? "settings.title")
    : t("settings.groupNav")

  return (
    <div data-slot="settings-page" className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2 sm:px-4 md:px-6">
        {isDesktop ? (
          <>
            <div className="flex min-w-0 items-center gap-2 sm:gap-3">
              <h1 className="text-lg font-semibold text-foreground">{t("settings.title")}</h1>
              {loading && <LoaderIcon className="h-4 w-4 animate-spin text-muted-foreground" />}
              {mergedError && (
                <span className="flex min-w-0 items-center gap-1 text-sm text-destructive">
                  <AlertCircleIcon className="h-4 w-4 shrink-0" />
                  <span className="truncate">{mergedError}</span>
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 sm:gap-3">
              <Button
                size="sm"
                variant="outline"
                disabled={restarting}
                onClick={handleRestart}
              >
                <RotateCcwIcon className={`mr-1.5 h-4 w-4 ${restarting ? "animate-spin" : ""}`} />
                {restarting ? t("settings.restarting") : t("settings.restart")}
              </Button>
              <Button
                size="sm"
                disabled={!hasDirty || saveState === "saving"}
                onClick={handleSave}
              >
                {getSaveButtonIcon(saveState)}
                {saveState === "saved" ? t("common.saved") : t("common.save")}
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="flex min-w-0 items-center gap-2">
              {mobileGroup && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={handleMobileBack}
                  aria-label={t("common.back")}
                >
                  <ArrowLeftIcon className="size-4" />
                </Button>
              )}
              <h2 className="truncate text-sm font-medium text-foreground">{mobileGroupTitle}</h2>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={restarting}
              onClick={handleRestart}
            >
              <RotateCcwIcon className={`mr-1.5 h-4 w-4 ${restarting ? "animate-spin" : ""}`} />
              {restarting ? t("settings.restarting") : t("settings.restart")}
            </Button>
          </>
        )}
      </div>

      {/* Content */}
      <div className={cn(
        "flex-1 overflow-y-auto px-3 py-4 sm:px-4 md:px-6",
        !isDesktop && hasDirty && "pb-24",
        isDesktop && "md:py-6",
      )}>
        <div className="mx-auto max-w-6xl">
          {isDesktop ? (
            <div className="grid items-start gap-6 md:grid-cols-[220px_minmax(0,1fr)] lg:grid-cols-[240px_minmax(0,1fr)]">
              <SettingsSubNav
                activeGroup={activeGroup}
                dirtyByGroup={dirtyByGroup}
                onGroupChange={handleGroupChange}
              />
              <div className="min-w-0">
                <div className="flex flex-col gap-6">
                  {SETTINGS_GROUPS.map((group) => (
                    <SettingsGroupPanel key={group.id} group={group.id} activeGroup={activeGroup}>
                      <SettingsGroupContent group={group.id} rpc={rpc} config={config} onChange={setField} />
                    </SettingsGroupPanel>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <>
              {mergedError && (
                <div className="mb-4 flex items-center gap-1 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  <AlertCircleIcon className="h-4 w-4 shrink-0" />
                  <span>{mergedError}</span>
                </div>
              )}
              {mobileGroup ? (
                <div className="flex flex-col gap-6">
                  <SettingsGroupContent group={mobileGroup} rpc={rpc} config={config} onChange={setField} />
                </div>
              ) : (
                <SettingsMobileGroupList
                  activeGroup={activeGroup}
                  dirtyByGroup={dirtyByGroup}
                  onOpenGroup={handleMobileGroupOpen}
                />
              )}
            </>
          )}
        </div>
      </div>

      {!isDesktop && hasDirty && (
        <div className="border-t border-border bg-background/95 px-3 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80">
          <div className="mx-auto flex max-w-6xl items-center gap-2">
            <Button
              size="sm"
              disabled={saveState === "saving"}
              onClick={handleSave}
              className="flex-1"
            >
              {getSaveButtonIcon(saveState)}
              {saveState === "saved" ? t("common.saved") : t("common.save")}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
