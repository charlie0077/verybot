import { useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { LoaderIcon, AlertCircleIcon, LogInIcon } from "lucide-react"
import { useGatewayContext } from "@/contexts/gateway-context"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { MaskedInput } from "@/components/ui/masked-input"

interface LoginGateProps {
  children: ReactNode
}

export function LoginGate({ children }: LoginGateProps) {
  const { status, token, authError, setToken, disconnect } = useGatewayContext()

  // Connected — render app
  if (status === "connected") return <>{children}</>

  // Connecting with a token — show spinner
  if (status === "connecting" && token !== null && !authError) {
    return <ConnectingScreen onCancel={disconnect} />
  }

  // No token OR auth error — show login
  return <LoginScreen authError={authError} onConnect={setToken} />
}

function ConnectingScreen({ onCancel }: { onCancel: () => void }) {
  const { t } = useTranslation()
  return (
    <div data-slot="connecting-screen" className="flex h-dvh items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-4">
        <LoaderIcon className="h-8 w-8 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{t("common.connecting")}</p>
        <Button variant="outline" size="sm" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
      </div>
    </div>
  )
}

interface LoginScreenProps {
  authError: string | null
  onConnect: (token: string) => void
}

function LoginScreen({ authError, onConnect }: LoginScreenProps) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState("")

  const trimmed = draft.trim()
  const authErrorMessage = authError === "login.authFailed" ? t("login.authFailed") : authError

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!trimmed) return
    onConnect(trimmed)
  }

  return (
    <div data-slot="login-screen" className="flex h-dvh items-center justify-center bg-background px-4">
      <Card interactive className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle className="text-xl">{t("login.title")}</CardTitle>
          <p className="text-sm text-muted-foreground">{t("login.subtitle")}</p>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            {authError && (
              <div className="flex items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                <AlertCircleIcon className="h-4 w-4 shrink-0" />
                <span>{authErrorMessage}</span>
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              <MaskedInput
                value={draft}
                onValueChange={setDraft}
                placeholder={t("login.tokenPlaceholder")}
                autoFocus
              />
              <p className="text-xs text-muted-foreground">{t("login.tokenHint")}</p>
            </div>
            <Button type="submit" disabled={!trimmed}>
              <LogInIcon className="mr-1.5 h-4 w-4" />
              {t("login.connect")}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
