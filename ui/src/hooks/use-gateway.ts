import { useEffect, useRef } from "react"
import { useGatewayContext } from "@/contexts/gateway-context"

export type ConnectionStatus = "connecting" | "connected" | "disconnected"

export interface ChatDelta {
  sessionKey: string
  state: "delta" | "final"
  delta?: string
  message?: { role: string; content: unknown }
  usage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
}

export interface DelegationEvent {
  agentId: string
  agentName?: string
  taskId?: string
  status: "started" | "completed" | "failed"
  resultLength?: number
  error?: string
}

export interface SubscriptionEvent {
  agentId: string
  agentName?: string
  taskId: string
  status: "started" | "completed" | "failed"
  resultLength?: number
  error?: string
}

export interface AgentEvent {
  sessionKey: string
  agentId?: string
  tools?: { name: string; args: unknown }[]
  delegation?: DelegationEvent
  subscription?: SubscriptionEvent
}

/**
 * Hook for chat pages that need streaming events.
 * Subscribes to chat/agent events via the shared GatewayProvider connection.
 * Uses refs to avoid subscription churn when callbacks change identity.
 */
export function useGateway(
  onChatEvent: (e: ChatDelta) => void,
  onAgentEvent: (e: AgentEvent) => void,
) {
  const { status, sendMessage, rpc, onChatEvent: subscribe, onAgentEvent: subscribeAgent } =
    useGatewayContext()

  const chatRef = useRef(onChatEvent)
  chatRef.current = onChatEvent

  const agentRef = useRef(onAgentEvent)
  agentRef.current = onAgentEvent

  useEffect(() => subscribe((e) => chatRef.current(e)), [subscribe])
  useEffect(() => subscribeAgent((e) => agentRef.current(e)), [subscribeAgent])

  return { status, sendMessage, rpc }
}
