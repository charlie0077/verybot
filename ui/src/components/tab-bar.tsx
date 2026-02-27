import { memo, useState } from "react"
import { useTranslation } from "react-i18next"
import { PlusIcon, XIcon, ListXIcon, LoaderIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { TabInfo } from "@/hooks/use-session-tabs"

/* Chrome-style inverse rounded corners on active tab */
const tabScoopStyles = `
.tab-active::before,
.tab-active::after {
  content: "";
  position: absolute;
  bottom: 0;
  width: 10px;
  height: 10px;
  pointer-events: none;
}
.tab-active::before {
  left: -10px;
  background: radial-gradient(circle at 0 0, transparent 10px, var(--background) 10.5px);
}
.tab-active::after {
  right: -10px;
  background: radial-gradient(circle at 100% 0, transparent 10px, var(--background) 10.5px);
}
`

/* ------------------------------------------------------------------ */
/*  TabItem                                                            */
/* ------------------------------------------------------------------ */

interface TabItemProps {
  tab: TabInfo
  active: boolean
  running: boolean
  onSwitch: () => void
  onClose: () => void
  onRename: (name: string) => void
}

function TabItem({
  tab,
  active,
  running,
  onSwitch,
  onClose,
  onRename,
}: TabItemProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(tab.name)

  function startEditing() {
    setDraft(tab.name)
    setEditing(true)
  }

  function commitRename() {
    const trimmed = draft.trim()
    if (trimmed && trimmed !== tab.name) onRename(trimmed)
    setEditing(false)
  }

  return (
    <div
      data-slot="tab-item"
      role="tab"
      onClick={!editing ? onSwitch : undefined}
      onDoubleClick={!editing ? startEditing : undefined}
      className={cn(
        "group relative flex w-full min-w-0 cursor-pointer items-center gap-1.5 px-3 text-xs select-none",
        active
          ? "tab-active z-10 h-9 rounded-t-[10px] bg-background pb-0.5 text-foreground"
          : "mx-1 mb-1 h-8 rounded-[8px] text-muted-foreground hover:bg-muted-foreground/5 hover:text-foreground",
      )}
    >
      {editing ? (
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename()
            if (e.key === "Escape") setEditing(false)
          }}
          className="w-full bg-transparent text-xs outline-none"
          autoFocus
        />
      ) : (
        <>
          <div className="flex min-w-0 flex-1 items-center">
            {running && (
              <LoaderIcon
                aria-label="running"
                className="mr-1.5 size-3 animate-spin text-muted-foreground"
              />
            )}
            <span className="min-w-0 truncate leading-normal">{tab.name}</span>
          </div>
        </>
      )}

      <button
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
        className={cn(
          "ml-auto flex size-4 shrink-0 items-center justify-center rounded-sm transition-opacity hover:bg-muted-foreground/20",
          active ? "opacity-60 hover:opacity-100" : "hidden",
        )}
      >
        <XIcon className="size-3" />
      </button>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  TabBar                                                             */
/* ------------------------------------------------------------------ */

interface TabBarProps {
  tabs: TabInfo[]
  activeKey: string
  isSessionRunning: (sessionKey: string) => boolean
  onSwitch: (key: string) => void
  onAdd: () => void
  onClose: (key: string) => void
  onCloseAll?: () => void
  onRename: (key: string, name: string) => void
}

export const TabBar = memo(function TabBar({
  tabs,
  activeKey,
  isSessionRunning,
  onSwitch,
  onAdd,
  onClose,
  onCloseAll,
  onRename,
}: TabBarProps) {
  const { t } = useTranslation()
  const TAB_ACTIONS_GAP_CLASS = "ml-0.5"
  const TAB_ACTION_BUTTON_CLASS = "size-7 rounded-lg text-muted-foreground"
  const TAB_DIVIDER_CLASS = "mb-2.5 h-4 w-px shrink-0 bg-muted-foreground/30"
  const actionTabPrevIsActive = tabs.length > 0 && tabs[tabs.length - 1].key === activeKey
  // Treat "+" as a tab-like item for divider logic.
  const showActionDivider = tabs.length > 0 && !actionTabPrevIsActive

  return (
    <div
      data-slot="tab-bar"
      className="relative flex items-end bg-muted px-1 pt-1 sm:px-2"
    >
      <style>{tabScoopStyles}</style>
      <div className="scrollbar-hidden relative z-0 flex min-w-0 flex-1 items-end overflow-x-auto">
        {tabs.map((tab, i) => {
          const isActive = tab.key === activeKey
          // Hide divider when either neighbor is the active tab
          const prevIsActive = i > 0 && tabs[i - 1].key === activeKey
          const showDivider = i > 0 && !isActive && !prevIsActive
          return (
            <div key={tab.key} className="flex w-44 min-w-0 shrink items-end sm:w-52 lg:w-56">
              {showDivider && (
                <div className={TAB_DIVIDER_CLASS} />
              )}
              <TabItem
                tab={tab}
                active={isActive}
                running={isSessionRunning(tab.key)}
                onSwitch={() => onSwitch(tab.key)}
                onClose={() => onClose(tab.key)}
                onRename={(name) => onRename(tab.key, name)}
              />
            </div>
          )
        })}
        <div className={cn(TAB_ACTIONS_GAP_CLASS, "mb-1 flex shrink-0 items-center")}>
          {showActionDivider && <div className={cn(TAB_DIVIDER_CLASS, "mb-0 self-center")} />}
          <Button
            onClick={onAdd}
            variant="ghost"
            size="icon"
            className={TAB_ACTION_BUTTON_CLASS}
            title={t("chat.newTab")}
          >
            <PlusIcon className="size-3.5" />
          </Button>
          {onCloseAll && (
            <Button
              onClick={onCloseAll}
              variant="ghost"
              size="icon"
              className={cn("ml-0.5", TAB_ACTION_BUTTON_CLASS)}
              title={t("chat.closeAllTabs")}
            >
              <ListXIcon className="size-3.5" />
            </Button>
          )}
        </div>
      </div>
    </div>
  )
})
TabBar.displayName = "TabBar"

export type { TabBarProps }
