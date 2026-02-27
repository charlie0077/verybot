import { useState, useRef, useEffect, useCallback } from "react"
import { useTranslation } from "react-i18next"
import { ChatInputBar } from "@/components/chat-input-bar"
import { LoaderIcon } from "lucide-react"
import type { SchedulerMessage } from "./types"
import type { ChatCommandDefinition } from "@/lib/chat-commands"

const TASK_RESULT_PREFIX = "[Task Result |"
const SCHEDULED_TASK_PREFIX = "[Scheduled Task]"

function MessageBubble({ message }: { message: SchedulerMessage }) {
  const { t } = useTranslation()
  const isTaskResult = message.content.startsWith(TASK_RESULT_PREFIX)
  const isScheduledTask = message.role === "user" && message.content.startsWith(SCHEDULED_TASK_PREFIX)

  // Compact task result one-liners
  if (isTaskResult) {
    return (
      <div className="flex justify-center">
        <span className="rounded-md bg-muted px-3 py-1.5 text-xs text-muted-foreground">
          {message.content}
        </span>
      </div>
    )
  }

  // Scheduled task prompt
  if (isScheduledTask) {
    return (
      <div className="flex justify-start">
        <div className="rounded-xl border border-chart-4/30 bg-chart-4/5 px-4 py-2.5">
          <p className="text-xs font-medium text-chart-4">{t("scheduler.scheduledTask")}</p>
          <p className="mt-1 text-sm text-foreground">
            {message.content.replace(SCHEDULED_TASK_PREFIX, "").trim()}
          </p>
        </div>
      </div>
    )
  }

  // System message (command feedback)
  if (message.role === "system") {
    return (
      <div className="flex justify-center">
        <span className="rounded-md bg-muted px-3 py-1.5 text-xs text-muted-foreground">
          {message.content}
        </span>
      </div>
    )
  }

  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="rounded-xl bg-primary px-4.5 py-3">
          {message.senderInfo && (
            <p className="mb-0.5 text-xs text-primary-foreground/70">{message.senderInfo}</p>
          )}
          <p className="text-sm leading-normal text-primary-foreground">{message.content}</p>
        </div>
      </div>
    )
  }

  // Assistant
  return (
    <div className="flex justify-start">
      <div className="rounded-xl bg-card ring-1 ring-foreground/10 px-4.5 py-3.5">
        <p className="max-w-xl whitespace-pre-wrap text-sm leading-normal text-foreground">
          {message.content}
        </p>
      </div>
    </div>
  )
}

interface SchedulerChatProps {
  messages: SchedulerMessage[]
  connected: boolean
  sending: boolean
  slashCommands?: ChatCommandDefinition[]
  onSend: (text: string) => void
  onCommand: (command: string) => Promise<void>
  onAddAlias?: (alias: string, expansion: string) => Promise<void>
}

export function SchedulerChat({
  messages,
  connected,
  sending,
  slashCommands = [],
  onSend,
  onCommand,
  onAddAlias,
}: SchedulerChatProps) {
  const { t } = useTranslation()
  const [input, setInput] = useState("")
  const bottomRef = useRef<HTMLDivElement>(null)

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [])

  useEffect(scrollToBottom, [messages, sending, scrollToBottom])

  function handleSend(textOverride?: string) {
    const text = (textOverride ?? input).trim()
    if (!text || !connected) return
    setInput("")

    if (text.startsWith("/")) {
      void onCommand(text)
      return
    }

    onSend(text)
  }

  return (
    <div className="flex h-full flex-col">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto">
        <div className="flex flex-col gap-4 px-3 py-3 sm:px-6 sm:py-4">
          {messages.length === 0 ? (
            <p className="pt-8 text-center text-sm text-muted-foreground sm:pt-12">
              {t("scheduler.emptyChatMessage")}
            </p>
          ) : null}
          {messages.map((msg) => (
            <MessageBubble key={msg.id} message={msg} />
          ))}
          {sending ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <LoaderIcon className="size-4 animate-spin" />
              <span>{t("chat.assistantThinking")}</span>
            </div>
          ) : null}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* Input */}
      <ChatInputBar
        value={input}
        onChange={setInput}
        onSend={handleSend}
        connected={connected}
        sending={sending}
        slashCommands={slashCommands}
        onAddAlias={onAddAlias}
        placeholder={t("scheduler.chatPlaceholder")}
      />
    </div>
  )
}
