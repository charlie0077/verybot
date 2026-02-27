import { useState, useEffect, useRef, useCallback, type KeyboardEvent } from "react"
import { useTranslation } from "react-i18next"
import {
  LoaderIcon,
  WifiOffIcon,
  CheckCircle2Icon,
  CircleDashedIcon,
  SettingsIcon,
  AlertCircleIcon,
  LinkIcon,
  UnlinkIcon,
  SmartphoneIcon,
} from "lucide-react"
import { Link, useNavigate } from "react-router"
import { useGatewayContext, type WhatsAppEvent } from "@/contexts/gateway-context"
import { useSessionResume } from "@/contexts/session-resume-context"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"

/** QR code expiry timeout — Baileys emits new QR ~every 20s; give up after 90s of no scan. */
const QR_EXPIRY_TIMEOUT_MS = 90_000

/** Channel definitions with display metadata. */
const CHANNEL_DEFS = [
  {
    id: "telegram",
    label: "Telegram",
    configKeys: ["TELEGRAM_BOT_TOKEN"],
    color: "bg-channel-telegram/20 text-channel-telegram",
    dotColor: "bg-channel-telegram",
  },
  {
    id: "discord",
    label: "Discord",
    configKeys: ["DISCORD_BOT_TOKEN"],
    color: "bg-channel-discord/20 text-channel-discord",
    dotColor: "bg-channel-discord",
  },
  {
    id: "slack",
    label: "Slack",
    configKeys: ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"],
    color: "bg-channel-slack/20 text-channel-slack",
    dotColor: "bg-channel-slack",
  },
] as const

type ConfigData = Record<string, unknown>

type WhatsAppStatus = "disconnected" | "linking" | "qr" | "connected"

/** Check whether a channel's required tokens are set (non-empty, possibly redacted). */
function isConfigured(config: ConfigData, keys: readonly string[]): boolean {
  return keys.every((k) => {
    const v = config[k]
    return typeof v === "string" && v !== ""
  })
}

function WhatsAppCard({
  config,
  refreshConfig,
  onEnterSession,
}: {
  config: ConfigData | null
  refreshConfig: () => void
  onEnterSession: () => void
}) {
  const { t } = useTranslation()
  const { rpc, onWhatsAppEvent } = useGatewayContext()
  const [waStatus, setWaStatus] = useState<WhatsAppStatus>("disconnected")
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [qrOpen, setQrOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const qrTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  const linked = config
    ? typeof config.WHATSAPP_PHONE_ID === "string" && config.WHATSAPP_PHONE_ID !== ""
    : false

  const channels = (config?.channels ?? {}) as Record<string, Record<string, unknown>>
  const selfOnly = !!(channels.whatsapp?.selfOnly)

  const handleSelfOnlyToggle = useCallback(async (checked: boolean) => {
    try {
      await rpc("config.patch", { patch: { channels: { whatsapp: { selfOnly: checked } } } })
      refreshConfig()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update setting")
    }
  }, [rpc, refreshConfig])

  // Clean up timeout on unmount
  useEffect(() => () => clearTimeout(qrTimeoutRef.current), [])

  // Subscribe to WhatsApp events
  useEffect(() => {
    return onWhatsAppEvent((evt: WhatsAppEvent) => {
      if (evt.type === "qr") {
        setQrDataUrl(evt.dataUrl)
        setWaStatus("qr")
        setQrOpen(true)
        // Reset QR expiry timeout — Baileys re-emits QR every ~20s
        clearTimeout(qrTimeoutRef.current)
        qrTimeoutRef.current = setTimeout(() => {
          setWaStatus("disconnected")
          setQrOpen(false)
          setError(t("channels.qrExpired"))
        }, QR_EXPIRY_TIMEOUT_MS)
      } else if (evt.type === "connected") {
        clearTimeout(qrTimeoutRef.current)
        setWaStatus("connected")
        setQrOpen(false)
        setQrDataUrl(null)
        setError(null)
        refreshConfig()
      } else if (evt.type === "disconnected") {
        setWaStatus((prev) => {
          // During linking, a disconnect means the connection attempt failed
          if (prev === "linking" || prev === "qr") {
            clearTimeout(qrTimeoutRef.current)
            setQrOpen(false)
            setError(t("channels.connectionFailed"))
            return "disconnected"
          }
          return "disconnected"
        })
      }
    })
  }, [onWhatsAppEvent, refreshConfig])

  // Sync status from config on initial load
  useEffect(() => {
    if (linked && waStatus === "disconnected") {
      setWaStatus("connected")
    }
    if (!linked && waStatus === "connected") {
      setWaStatus("disconnected")
    }
  }, [linked]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleLink = useCallback(async () => {
    setError(null)
    setWaStatus("linking")
    try {
      await rpc("whatsapp.link")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to link")
      setWaStatus("disconnected")
    }
  }, [rpc])

  const handleUnlink = useCallback(async () => {
    setError(null)
    try {
      await rpc("whatsapp.unlink")
      setWaStatus("disconnected")
      setQrDataUrl(null)
      refreshConfig()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to unlink")
    }
  }, [rpc, refreshConfig])

  const isConnected = waStatus === "connected"
  const isLinking = waStatus === "linking"
  const isQr = waStatus === "qr"
  const canActivateCard = isConnected || (!isLinking && !isQr)

  const handleCardActivate = useCallback(() => {
    if (isConnected) {
      onEnterSession()
      return
    }
    if (!isLinking && !isQr) {
      void handleLink()
    }
  }, [isConnected, isLinking, isQr, onEnterSession, handleLink])

  const handleCardKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.currentTarget !== event.target) return
    if (event.key !== "Enter" && event.key !== " ") return
    event.preventDefault()
    handleCardActivate()
  }, [handleCardActivate])

  return (
    <>
      <Card
        size="sm"
        interactive={canActivateCard}
        className="gap-0 py-0"
        role={canActivateCard ? "button" : undefined}
        tabIndex={canActivateCard ? 0 : undefined}
        onClick={canActivateCard ? handleCardActivate : undefined}
        onKeyDown={canActivateCard ? handleCardKeyDown : undefined}
        aria-label={isConnected ? t("channels.enterSession") : t("channels.linkWhatsApp")}
      >
        <div className="flex flex-col gap-3 px-5 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="size-3 rounded-full bg-channel-whatsapp" />
              <div className="flex flex-col gap-0.5">
                <span className="text-sm font-medium text-foreground">WhatsApp</span>
                <span className="text-xs text-muted-foreground">
                  {isConnected
                    ? t("channels.linkedViaQr")
                    : isLinking || isQr
                      ? t("channels.waitingForQrScan")
                      : t("channels.linkViaQr")}
                </span>
                {error && (
                  <span className="flex items-center gap-1 text-xs text-destructive">
                    <AlertCircleIcon className="size-3" />
                    {error}
                  </span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Badge
                variant={isConnected ? "secondary" : "outline"}
                className={
                  isConnected
                    ? "gap-1.5 bg-success/10 text-success"
                    : "gap-1.5"
                }
              >
                {isConnected ? (
                  <>
                    <CheckCircle2Icon className="size-3" />
                    {t("channels.connected")}
                  </>
                ) : (
                  <>
                    <CircleDashedIcon className="size-3" />
                    {t("channels.notLinked")}
                  </>
                )}
              </Badge>
              {isConnected ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5 text-xs"
                  onClick={(event) => {
                    event.stopPropagation()
                    void handleUnlink()
                  }}
                >
                  <UnlinkIcon className="size-3.5" />
                  {t("channels.unlink")}
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5 text-xs"
                  onClick={(event) => {
                    event.stopPropagation()
                    void handleLink()
                  }}
                  disabled={isLinking || isQr}
                >
                  {isLinking ? (
                    <LoaderIcon className="size-3.5 animate-spin" />
                  ) : (
                    <LinkIcon className="size-3.5" />
                  )}
                  {t("channels.linkWhatsApp")}
                </Button>
              )}
            </div>
          </div>
          {isConnected && (
            <div
              className="flex items-center justify-between border-t border-border pt-3"
              onClick={(event) => event.stopPropagation()}
            >
              <Label htmlFor="wa-self-only" className="text-xs text-muted-foreground">
                {t("channels.selfChatOnly")}
              </Label>
              <Switch
                id="wa-self-only"
                checked={selfOnly}
                onCheckedChange={handleSelfOnlyToggle}
              />
            </div>
          )}
        </div>
      </Card>

      {/* QR Code Dialog */}
      <Dialog open={qrOpen} onOpenChange={setQrOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("channels.scanQrCode")}</DialogTitle>
            <DialogDescription>
              {t("channels.scanQrDescription")}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col items-center gap-4 py-4">
            {qrDataUrl ? (
              <img
                src={qrDataUrl}
                alt="WhatsApp QR Code"
                className="size-64 rounded-lg"
              />
            ) : (
              <div className="flex size-64 items-center justify-center rounded-lg bg-muted">
                <LoaderIcon className="size-8 animate-spin text-muted-foreground" />
              </div>
            )}
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <SmartphoneIcon className="size-4" />
              <span>{t("channels.waitingForScan")}</span>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

interface SessionEntry {
  key: string
  channelType?: string
  updatedAt: number
  title?: string
  agentId?: string
  agentName?: string
}

/**
 * Find the most recent session for a given channel type and resume it in chat.
 * If no session exists, just navigate to /chat.
 */
function useChannelSessionOpener() {
  const { rpc } = useGatewayContext()
  const resumeSession = useSessionResume()
  const navigate = useNavigate()

  return useCallback(async (channelId: string) => {
    try {
      const raw = await rpc("sessions.list") as { sessions?: SessionEntry[] }
      const sessions = Array.isArray(raw?.sessions) ? raw.sessions : []
      const match = sessions
        .filter((s) => {
          if (s.channelType === channelId) return true
          // Fallback: parse key format "teamId:channel:channelId"
          const parts = s.key.split(":")
          return parts[1] === channelId
        })
        .sort((a, b) => b.updatedAt - a.updatedAt)[0]

      if (match) {
        await resumeSession(match.key, match.title, {
          channelType: match.channelType,
          agentId: match.agentId,
          agentName: match.agentName,
        })
      }
      navigate("/chat")
    } catch {
      navigate("/chat")
    }
  }, [rpc, resumeSession, navigate])
}

export function ChannelsPage() {
  const { t } = useTranslation()
  const { rpc, status } = useGatewayContext()
  const openChannelSession = useChannelSessionOpener()
  const navigate = useNavigate()
  const [config, setConfig] = useState<ConfigData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const fetchConfig = useCallback(() => {
    if (status !== "connected") return
    setLoading(true)
    rpc("config.get")
      .then((configRes) => {
        if (!mountedRef.current) return
        setConfig((configRes as { config: ConfigData }).config)
        setError(null)
      })
      .catch((err) => {
        if (mountedRef.current) {
          setError(err instanceof Error ? err.message : "Failed to load config")
        }
      })
      .finally(() => {
        if (mountedRef.current) setLoading(false)
      })
  }, [status, rpc])

  useEffect(() => {
    fetchConfig()
  }, [fetchConfig])

  const handleChannelCardClick = useCallback((channelId: string, configured: boolean) => {
    if (configured) {
      void openChannelSession(channelId)
      return
    }
    navigate("/settings")
  }, [navigate, openChannelSession])

  if (status !== "connected") {
    return (
      <div data-slot="channels-page" className="flex h-full items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <WifiOffIcon className="size-8" />
          <p className="text-sm">
            {status === "connecting" ? t("common.connecting") : t("common.disconnected")}
          </p>
        </div>
      </div>
    )
  }

  return (
    <div data-slot="channels-page" className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-6 py-2">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold text-foreground">{t("channels.title")}</h1>
          {loading && <LoaderIcon className="size-4 animate-spin text-muted-foreground" />}
          {error && (
            <span className="flex items-center gap-1 text-sm text-destructive">
              <AlertCircleIcon className="size-3.5" />
              {error}
            </span>
          )}
        </div>
        <Link to="/settings">
          <Button variant="outline" size="sm" className="gap-2 text-xs">
            <SettingsIcon className="size-3.5" />
            {t("channels.configureTokens")}
          </Button>
        </Link>
      </div>

      {/* Channel list */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto flex max-w-2xl flex-col gap-3">
          {CHANNEL_DEFS.map((ch) => {
            const configured = config ? isConfigured(config, ch.configKeys) : false
            return (
              <Card
                key={ch.id}
                size="sm"
                interactive
                className="gap-0 py-0"
                role="button"
                tabIndex={0}
                onClick={() => handleChannelCardClick(ch.id, configured)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return
                  event.preventDefault()
                  handleChannelCardClick(ch.id, configured)
                }}
                aria-label={`${ch.label} ${configured ? t("channels.enterSession") : t("channels.configureTokens")}`}
              >
                <div className="flex items-center justify-between px-5 py-4">
                  <div className="flex items-center gap-4">
                    {/* Color dot */}
                    <div className={cn("size-3 rounded-full", ch.dotColor)} />
                    <div className="flex flex-col gap-0.5">
                      <span className="text-sm font-medium text-foreground">{ch.label}</span>
                      <span className="text-xs text-muted-foreground">
                        {t("channels.tokensRequired", { count: ch.configKeys.length })}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge
                      variant={configured ? "secondary" : "outline"}
                      className={
                        configured
                          ? "gap-1.5 bg-success/10 text-success"
                          : "gap-1.5"
                      }
                    >
                      {configured ? (
                        <>
                          <CheckCircle2Icon className="size-3" />
                          {t("channels.configured")}
                        </>
                      ) : (
                        <>
                          <CircleDashedIcon className="size-3" />
                          {t("channels.notConfigured")}
                        </>
                      )}
                    </Badge>
                  </div>
                </div>
              </Card>
            )
          })}

          {/* WhatsApp — separate card with Link/Unlink flow */}
          <WhatsAppCard config={config} refreshConfig={fetchConfig} onEnterSession={() => openChannelSession("whatsapp")} />
        </div>
      </div>
    </div>
  )
}
