import { createContext, useContext, useRef, useCallback, type ReactNode } from "react"
import type { ResumeSessionMeta } from "@/hooks/use-session-tabs"

type ResumeFn = (sessionKey: string, title?: string, meta?: ResumeSessionMeta) => Promise<void>
type StartSessionFn = (teamId: string, message: string) => Promise<void>

interface SessionResumeContextValue {
  resumeSession: ResumeFn
  startSession: StartSessionFn
  /** Called by ChatPage to register its resumeSession handler. */
  register: (fn: ResumeFn) => void
  /** Called by ChatPage to register its startSession handler. */
  registerStartSession: (fn: StartSessionFn) => void
}

const SessionResumeContext = createContext<SessionResumeContextValue | null>(null)

export function SessionResumeProvider({ children }: { children: ReactNode }) {
  const fnRef = useRef<ResumeFn>(async () => {})
  const startFnRef = useRef<StartSessionFn>(async () => {})

  const register = useCallback((fn: ResumeFn) => {
    fnRef.current = fn
  }, [])

  const registerStartSession = useCallback((fn: StartSessionFn) => {
    startFnRef.current = fn
  }, [])

  const resumeSession: ResumeFn = useCallback(async (sessionKey, title, meta) => {
    await fnRef.current(sessionKey, title, meta)
  }, [])

  const startSession: StartSessionFn = useCallback(async (teamId, message) => {
    await startFnRef.current(teamId, message)
  }, [])

  return (
    <SessionResumeContext.Provider value={{ resumeSession, startSession, register, registerStartSession }}>
      {children}
    </SessionResumeContext.Provider>
  )
}

export function useSessionResume() {
  const ctx = useContext(SessionResumeContext)
  if (!ctx) throw new Error("useSessionResume must be used within SessionResumeProvider")
  return ctx.resumeSession
}

export function useSessionResumeRegister() {
  const ctx = useContext(SessionResumeContext)
  if (!ctx) throw new Error("useSessionResumeRegister must be used within SessionResumeProvider")
  return ctx.register
}

export function useStartSession() {
  const ctx = useContext(SessionResumeContext)
  if (!ctx) throw new Error("useStartSession must be used within SessionResumeProvider")
  return ctx.startSession
}

export function useStartSessionRegister() {
  const ctx = useContext(SessionResumeContext)
  if (!ctx) throw new Error("useStartSessionRegister must be used within SessionResumeProvider")
  return ctx.registerStartSession
}
