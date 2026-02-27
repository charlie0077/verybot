import { useEffect, useMemo, useState } from "react"
import { Outlet, useLocation } from "react-router"
import { useTranslation } from "react-i18next"
import { useMediaQuery } from "usehooks-ts"
import { MenuIcon } from "lucide-react"
import { Sidebar } from "@/components/sidebar"
import { ChatPage } from "@/components/chat-page"
import { SessionResumeProvider } from "@/contexts/session-resume-context"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"

const DARK_MODE_KEY = "verybot-dark-mode"
const MOBILE_BREAKPOINT_QUERY = "(min-width: 768px)"

const MOBILE_PAGE_TITLES = {
  chat: "nav.chat",
  channels: "nav.channels",
  sessions: "nav.sessions",
  scheduler: "nav.scheduler",
  tasks: "nav.tasks",
  logs: "nav.logs",
  settings: "nav.settings",
  teams: "nav.teams",
  "prompt-templates": "nav.promptTemplates",
  playbooks: "nav.playbooks",
} as const

type MobilePageTitleKey = (typeof MOBILE_PAGE_TITLES)[keyof typeof MOBILE_PAGE_TITLES]

function resolveMobilePageTitle(pathname: string): MobilePageTitleKey {
  const firstSegment = pathname.split("/")[1] ?? ""
  if (firstSegment in MOBILE_PAGE_TITLES) {
    return MOBILE_PAGE_TITLES[firstSegment as keyof typeof MOBILE_PAGE_TITLES]
  }
  return MOBILE_PAGE_TITLES.chat
}

export function AppLayout() {
  const { t } = useTranslation()
  const location = useLocation()
  const isDesktop = useMediaQuery(MOBILE_BREAKPOINT_QUERY)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const isChat = location.pathname === "/" || location.pathname === "/chat"
  const dialogOpen = !isDesktop && mobileNavOpen
  const mobileTitleKey = useMemo(
    () => resolveMobilePageTitle(location.pathname),
    [location.pathname],
  )

  useEffect(() => {
    if (!isDesktop) return
    setMobileNavOpen(false)
  }, [isDesktop])

  // Apply dark mode class on mount from localStorage / system preference
  useEffect(() => {
    const stored = localStorage.getItem(DARK_MODE_KEY)
    const dark = stored !== null
      ? stored === "true"
      : window.matchMedia("(prefers-color-scheme: dark)").matches
    document.documentElement.classList.toggle("dark", dark)
  }, [])

  return (
    <SessionResumeProvider>
      <div className="flex h-dvh w-full bg-background">
        <div className="hidden h-full md:flex">
          <Sidebar />
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-12 items-center gap-2 border-b border-border px-3 md:hidden">
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={t("nav.teams")}
              onClick={() => setMobileNavOpen(true)}
            >
              <MenuIcon className="size-4" />
            </Button>
            <h1 className="truncate text-sm font-semibold text-foreground">
              {t(mobileTitleKey)}
            </h1>
          </header>
          <main className="min-h-0 flex-1 overflow-auto">
            {/* ChatPage stays mounted to preserve WS connection + tab state */}
            <div className={isChat ? "h-full overflow-hidden" : "hidden"}>
              <ChatPage />
            </div>
            {!isChat && <Outlet />}
          </main>
        </div>
      </div>
      <Dialog open={dialogOpen} onOpenChange={setMobileNavOpen}>
        <DialogContent className="top-0 left-0 h-full w-72 max-w-full translate-x-0 translate-y-0 rounded-none p-0 md:hidden">
          <DialogTitle className="sr-only">{t("nav.teams")}</DialogTitle>
          <Sidebar onNavigate={() => setMobileNavOpen(false)} />
        </DialogContent>
      </Dialog>
    </SessionResumeProvider>
  )
}
