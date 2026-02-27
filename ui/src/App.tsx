import { createBrowserRouter, Navigate, RouterProvider } from "react-router"
import { GatewayProvider } from "@/contexts/gateway-context"
import { LoginGate } from "@/components/login-gate"
import { AppLayout } from "@/components/app-layout"
import { TeamsProvider, TeamsLayout, TeamsListPage, TeamDetailPage } from "@/components/teams"
import { ArchivedTasksPage, EditTaskPage, TasksPage } from "@/components/tasks"
import { SchedulerPage } from "@/components/scheduler"
import { SettingsPage } from "@/components/settings-page"
import { LogsPage } from "@/components/logs-page"
import { SessionsPage } from "@/components/sessions-page"
import { PromptTemplatesLayout, PromptTemplatesListPage, PromptTemplateDetailPage } from "@/components/prompt-templates"
import { ChannelsPage } from "@/components/channels-page"
import { PlaybooksLayout, PlaybooksListPage, PlaybookDetailPage } from "@/components/playbooks"

const router = createBrowserRouter([
  {
    path: "/",
    element: <AppLayout />,
    children: [
      { index: true, element: <Navigate to="/chat" replace /> },
      // ChatPage is always-mounted inside AppLayout to preserve WS + tab state.
      // This route exists only so the router recognises /chat as valid.
      { path: "chat", element: null },
      {
        path: "teams",
        element: <TeamsLayout />,
        children: [
          { index: true, element: <TeamsListPage /> },
          { path: "new", element: <TeamDetailPage /> },
          { path: ":teamId", element: <TeamDetailPage /> },
        ],
      },
      { path: "tasks", element: <TasksPage /> },
      { path: "tasks/archived", element: <ArchivedTasksPage /> },
      { path: "tasks/:teamId/:taskId", element: <EditTaskPage /> },
      { path: "scheduler", element: <SchedulerPage /> },
      { path: "settings", element: <SettingsPage /> },
      { path: "logs", element: <LogsPage /> },
      { path: "channels", element: <ChannelsPage /> },
      { path: "sessions", element: <SessionsPage /> },
      {
        path: "prompt-templates",
        element: <PromptTemplatesLayout />,
        children: [
          { index: true, element: <PromptTemplatesListPage /> },
          { path: "new", element: <PromptTemplateDetailPage /> },
          { path: ":id", element: <PromptTemplateDetailPage /> },
        ],
      },
      {
        path: "playbooks",
        element: <PlaybooksLayout />,
        children: [
          { index: true, element: <PlaybooksListPage /> },
          { path: "__new", element: <PlaybookDetailPage /> },
          { path: ":name", element: <PlaybookDetailPage /> },
        ],
      },
      { path: "*", element: <Navigate to="/chat" replace /> },
    ],
  },
])

export function App() {
  return (
    <GatewayProvider>
      <LoginGate>
        <TeamsProvider>
          <RouterProvider router={router} />
        </TeamsProvider>
      </LoginGate>
    </GatewayProvider>
  )
}
