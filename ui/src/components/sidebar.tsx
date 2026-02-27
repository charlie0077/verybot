import { Link, useLocation } from "react-router"
import { useTranslation } from "react-i18next"
import { useCallback, useEffect, useMemo, useState } from "react"
import { useLocalStorage } from "usehooks-ts"
import {
  MessageSquareIcon,
  HashIcon,
  FileTextIcon,
  TimerIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  PlusIcon,
  SettingsIcon,
  ListTodoIcon,
  ScrollTextIcon,
  BookTextIcon,
  BookOpenIcon,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { useGatewayContext } from "@/contexts/gateway-context"
import type { TeamInfo } from "@/components/team-picker"

type NavItem =
  | "chat"
  | "channels"
  | "sessions"
  | "scheduler"
  | "tasks"
  | "logs"
  | "prompt-templates"
  | "playbooks"
  | "settings"

const DEFAULT_TEAM_ID = "default"
const TEAM_QUERY_PARAM = "teamId"
const TEAM_SCOPED_STATIC_ITEMS = new Set<NavItem>(["chat", "sessions"])
const SIDEBAR_EXPANDED_TEAMS_STORAGE_KEY = "mvp-sidebar-expanded-teams"

const STATIC_NAV_SECTIONS = [
  {
    labelKey: "nav.chat",
    items: [
      { id: "chat" as NavItem, labelKey: "nav.chat", icon: MessageSquareIcon },
    ],
  },
  {
    labelKey: "nav.control",
    items: [
      { id: "channels" as NavItem, labelKey: "nav.channels", icon: HashIcon },
      { id: "sessions" as NavItem, labelKey: "nav.sessions", icon: FileTextIcon },
    ],
  },
  {
    labelKey: "nav.agent",
    items: [
      { id: "prompt-templates" as NavItem, labelKey: "nav.promptTemplates", icon: BookTextIcon },
      { id: "playbooks" as NavItem, labelKey: "nav.playbooks", icon: BookOpenIcon },
    ],
  },
] as const

const SYSTEM_NAV_SECTION = {
  labelKey: "nav.system",
  items: [
    { id: "settings" as NavItem, labelKey: "nav.settings", icon: SettingsIcon },
    { id: "logs" as NavItem, labelKey: "nav.logs", icon: ScrollTextIcon },
  ],
} as const

const TEAM_LINKS = [
  { id: "chat", labelKey: "nav.chat", icon: MessageSquareIcon },
  { id: "sessions", labelKey: "nav.sessions", icon: FileTextIcon },
  { id: "tasks", labelKey: "nav.task", icon: ListTodoIcon },
  { id: "scheduler", labelKey: "nav.scheduler", icon: TimerIcon },
] as const

interface SidebarProps {
  className?: string
  onNavigate?: () => void
}

export function Sidebar({ className, onNavigate }: SidebarProps) {
  const location = useLocation()
  const { t } = useTranslation()
  const { status, rpc, onTeamEvent } = useGatewayContext()
  const [version, setVersion] = useState<string | null>(null)
  const [teams, setTeams] = useState<TeamInfo[]>([])
  const [expandedTeams, setExpandedTeams] = useLocalStorage<Record<string, boolean>>(
    SIDEBAR_EXPANDED_TEAMS_STORAGE_KEY,
    {},
  )
  const pathSegment = location.pathname.split("/")[1] ?? ""
  const segment = pathSegment || "chat"
  const activeItem: NavItem | null = pathSegment === ""
    ? "chat"
    : STATIC_NAV_SECTIONS.some((section) => section.items.some((item) => item.id === segment))
        || SYSTEM_NAV_SECTION.items.some((item) => item.id === segment)
      ? (segment as NavItem)
      : null
  const activeTeamId = useMemo(
    () => new URLSearchParams(location.search).get(TEAM_QUERY_PARAM),
    [location.search],
  )
  const sidebarTeams = useMemo(() => {
    const userTeams = teams.filter((team) => team.id !== DEFAULT_TEAM_ID)
    return userTeams.length > 0 ? userTeams : teams
  }, [teams])

  const fetchTeams = useCallback(() => {
    if (status !== "connected") return
    rpc("chat.teams")
      .then((res) => setTeams((res as { teams: TeamInfo[] }).teams ?? []))
      .catch(() => setTeams([]))
  }, [status, rpc])

  useEffect(() => {
    if (status !== "connected") return
    rpc("system.version")
      .then((res) => setVersion((res as { version: string }).version))
      .catch(() => { /* version display is optional — hide gracefully */ })
  }, [status, rpc])

  useEffect(() => {
    fetchTeams()
  }, [fetchTeams])

  useEffect(() => {
    return onTeamEvent(() => fetchTeams())
  }, [onTeamEvent, fetchTeams])

  useEffect(() => {
    setExpandedTeams((prev) => {
      if (sidebarTeams.length === 0) return prev

      const next: Record<string, boolean> = {}
      for (const team of sidebarTeams) {
        next[team.id] = prev[team.id] ?? true
      }
      if (activeTeamId && activeTeamId in next && !(activeTeamId in prev)) {
        next[activeTeamId] = true
      }
      return next
    })
  }, [sidebarTeams, activeTeamId, setExpandedTeams])

  const statusText = status === "connected"
    ? t("settings.statusConnected")
    : status === "connecting"
      ? t("common.connecting")
      : t("common.disconnected")
  const handleNavigate = useCallback(() => onNavigate?.(), [onNavigate])

  return (
    <aside
      data-slot="sidebar"
      className={cn(
        "flex h-full w-full shrink-0 flex-col border-r border-sidebar-border bg-sidebar px-3 py-4 md:w-60",
        className,
      )}
    >
      {/* Logo */}
      <div className="-mt-2 flex items-center justify-center gap-2 rounded-lg p-1.5">
        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-gradient-to-br from-primary-foreground to-border">
          <span className="text-base font-semibold text-primary">V</span>
        </div>
        <span className="text-sm font-semibold text-sidebar-foreground tracking-tight">
          Verybot
        </span>
      </div>

      {/* Nav sections */}
      <nav className="scrollbar-hidden flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto pr-0.5">
        {STATIC_NAV_SECTIONS.map((section) => (
          <div key={section.labelKey} className="flex flex-col gap-0.5">
            <span className="px-2.5 py-0.5 text-xs font-medium tracking-wide text-muted-foreground">
              {t(section.labelKey)}
            </span>
            {section.items.map((item) => {
              const isActive = activeItem === item.id && !(activeTeamId && TEAM_SCOPED_STATIC_ITEMS.has(item.id))
              return (
                <Link
                  key={item.id}
                  to={`/${item.id}`}
                  onClick={handleNavigate}
                  className={cn(
                    "flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-sm transition-colors",
                    isActive
                      ? "bg-sidebar-accent/10 text-sidebar-foreground font-medium"
                      : "text-sidebar-foreground hover:bg-sidebar-accent/10",
                  )}
                >
                  <item.icon className="size-4" />
                  {t(item.labelKey)}
                </Link>
              )
            })}
          </div>
        ))}

        <div className="flex flex-col gap-0.5">
          <div className="group/teams-header flex w-full items-center py-0.5 pl-2.5 pr-0.5">
            <span className="text-xs font-medium tracking-wide text-muted-foreground">
              {t("nav.teams")}
            </span>
            <Link
              to="/teams/new"
              onClick={handleNavigate}
              title={t("teams.addTeam")}
              aria-label={t("teams.addTeam")}
              className={cn(
                "ml-auto flex size-5 items-center justify-center rounded-md text-muted-foreground transition-[opacity,color,background-color] hover:bg-sidebar-accent/10 hover:text-sidebar-foreground md:opacity-0 md:pointer-events-none md:group-hover/teams-header:opacity-100 md:group-hover/teams-header:pointer-events-auto md:group-focus-within/teams-header:opacity-100 md:group-focus-within/teams-header:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto",
                location.pathname === "/teams/new" && "bg-sidebar-accent/10 text-sidebar-foreground opacity-100 pointer-events-auto",
              )}
            >
              <PlusIcon className="size-3" />
            </Link>
          </div>
          {sidebarTeams.map((team) => {
            const isTeamDetailActive = location.pathname === `/teams/${team.id}`
            const isExpanded = expandedTeams[team.id] ?? true

            return (
              <div key={team.id} className="flex flex-col gap-0.5">
                <div
                  className={cn(
                    "flex h-9 items-center rounded-lg text-sm transition-colors",
                    isTeamDetailActive
                      ? "bg-sidebar-accent/10 text-sidebar-foreground font-medium"
                      : "text-sidebar-foreground",
                  )}
                >
                  <Link
                    to={`/teams/${team.id}`}
                    onClick={handleNavigate}
                    className="flex min-w-0 flex-1 items-center px-2.5"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      {team.color && (
                        <span
                          aria-hidden="true"
                          className="size-1.5 shrink-0 rounded-full"
                          style={{ backgroundColor: team.color }}
                        />
                      )}
                      <span className="truncate">{team.name}</span>
                    </div>
                  </Link>
                  <button
                    type="button"
                    aria-label={isExpanded ? `Collapse ${team.name}` : `Expand ${team.name}`}
                    onClick={(event) => {
                      event.preventDefault()
                      setExpandedTeams((prev) => ({ ...prev, [team.id]: !(prev[team.id] ?? true) }))
                    }}
                    className="mr-0.5 flex size-6 items-center justify-center rounded-md text-muted-foreground"
                  >
                    {isExpanded ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
                  </button>
                </div>
                {isExpanded && TEAM_LINKS.map((item) => {
                  const isActive = segment === item.id && activeTeamId === team.id

                  return (
                    <Link
                      key={`${team.id}-${item.id}`}
                      to={`/${item.id}?${TEAM_QUERY_PARAM}=${encodeURIComponent(team.id)}`}
                      onClick={handleNavigate}
                      className={cn(
                        "ml-2.5 flex h-8 items-center gap-2 rounded-lg px-2.5 text-sm transition-colors",
                        isActive
                          ? "bg-sidebar-accent/10 text-sidebar-foreground font-medium"
                          : "text-sidebar-foreground hover:bg-sidebar-accent/10",
                      )}
                    >
                      <item.icon className="size-3.5" />
                      {t(item.labelKey)}
                    </Link>
                  )
                })}
              </div>
            )
          })}
          {sidebarTeams.length === 0 && (
            <span className="px-2.5 py-0.5 text-xs text-muted-foreground">
              {t("common.noTeam")}
            </span>
          )}
        </div>

        <div className="flex flex-col gap-0.5">
          <span className="px-2.5 py-0.5 text-xs font-medium tracking-wide text-muted-foreground">
            {t(SYSTEM_NAV_SECTION.labelKey)}
          </span>
          {SYSTEM_NAV_SECTION.items.map((item) => {
            const isActive = activeItem === item.id
            return (
              <Link
                key={item.id}
                to={`/${item.id}`}
                onClick={handleNavigate}
                className={cn(
                  "flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-sm transition-colors",
                  isActive
                    ? "bg-sidebar-accent/10 text-sidebar-foreground font-medium"
                    : "text-sidebar-foreground hover:bg-sidebar-accent/10",
                )}
              >
                <item.icon className="size-4" />
                {t(item.labelKey)}
              </Link>
            )
          })}
        </div>
      </nav>

      {/* Footer: status + version on one line */}
      <div className="mt-1.5 px-2.5 text-xs text-muted-foreground">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2" title={statusText}>
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                status === "connected" && "bg-success",
                status === "connecting" && "animate-pulse bg-muted-foreground",
                status === "disconnected" && "bg-destructive",
              )}
            />
            <span className="min-w-0 truncate">{statusText}</span>
          </div>
          {version ? <span className="shrink-0 tabular-nums">v{version}</span> : null}
        </div>
      </div>
    </aside>
  )
}

export type { NavItem }
