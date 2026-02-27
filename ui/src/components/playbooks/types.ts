export interface PlaybookSummary {
  name: string
  description: string
  triggers: string[]
  tags: string[]
  inIndex: boolean
  onDisk: boolean
  readmeExists: boolean
  scriptCount: number
}

export interface PlaybookScriptCodeFile {
  path: string
  content: string
}

export interface PlaybookDetail extends PlaybookSummary {
  readme: string
  scriptFiles: string[]
  scriptCodeFiles: PlaybookScriptCodeFile[]
}

export interface PlaybookCreateInput {
  name: string
  description: string
  triggers: string[]
  tags: string[]
  readme: string
}

export interface PlaybookUpdateInput {
  name: string
  description: string
  triggers: string[]
  tags: string[]
  readme: string
  scriptCodeFiles?: PlaybookScriptCodeFile[]
}

export type SaveState = "idle" | "saving" | "saved" | "error"

export const SAVE_FEEDBACK_DURATION_MS = 2_000
export const PLAYBOOK_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9 _-]{0,63}$/
