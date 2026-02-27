import { useEffect, useMemo, useState } from "react"
import type { Extension } from "@codemirror/state"
import { StreamLanguage } from "@codemirror/language"
import { javascript } from "@codemirror/lang-javascript"
import { json } from "@codemirror/lang-json"
import { markdown } from "@codemirror/lang-markdown"
import { python } from "@codemirror/lang-python"
import { sql } from "@codemirror/lang-sql"
import { yaml } from "@codemirror/lang-yaml"
import { shell } from "@codemirror/legacy-modes/mode/shell"
import CodeMirror, { EditorState, getDefaultExtensions } from "@uiw/react-codemirror"
import { vscodeDark, vscodeLight } from "@uiw/codemirror-theme-vscode"

import { cn } from "@/lib/utils"

export interface LiveSyntaxEditorProps {
  value: string
  onChange: (nextValue: string) => void
  filePath?: string
  className?: string
}

const DEFAULT_LANGUAGE = javascript()
const SHELL_LANGUAGE = StreamLanguage.define(shell)
const SOFT_MAX_VISIBLE_LINES = 1000
const ESTIMATED_LINE_HEIGHT_PX = 20
const EDITOR_VERTICAL_PADDING_PX = 24
const EMPTY_EDITOR_DOC = ""
const BASIC_SETUP_OPTIONS = {
  foldGutter: false,
  lineNumbers: true,
  highlightActiveLine: false,
  highlightActiveLineGutter: false,
}

type ThemeOption = Extension | "none"
type BasicSetupOption = typeof BASIC_SETUP_OPTIONS | false

function detectLanguageExtension(filePath?: string): Extension {
  if (!filePath) return DEFAULT_LANGUAGE
  const normalizedPath = filePath.toLowerCase()
  const extensionStartIndex = normalizedPath.lastIndexOf(".")
  if (extensionStartIndex < 0) return DEFAULT_LANGUAGE
  const extension = normalizedPath.slice(extensionStartIndex)

  if (extension === ".bash" || extension === ".sh" || extension === ".zsh") return SHELL_LANGUAGE
  if (extension === ".cjs" || extension === ".js" || extension === ".mjs") return javascript()
  if (extension === ".json") return json()
  if (extension === ".md") return markdown()
  if (extension === ".py") return python()
  if (extension === ".sql") return sql()
  if (extension === ".ts") return javascript({ typescript: true })
  if (extension === ".tsx") return javascript({ typescript: true, jsx: true })
  if (extension === ".yaml" || extension === ".yml") return yaml()
  return DEFAULT_LANGUAGE
}

function isCompatibleExtension(extension: Extension): boolean {
  try {
    EditorState.create({ doc: EMPTY_EDITOR_DOC, extensions: [extension] })
    return true
  } catch {
    return false
  }
}

function resolveTheme(isDarkMode: boolean): ThemeOption {
  const preferredTheme = isDarkMode ? vscodeDark : vscodeLight
  if (isCompatibleExtension(preferredTheme)) return preferredTheme
  return "none"
}

function resolveLanguageExtensions(filePath?: string): Extension[] {
  const languageExtension = detectLanguageExtension(filePath)
  if (isCompatibleExtension(languageExtension)) return [languageExtension]
  return []
}

function resolveBasicSetup(): BasicSetupOption {
  try {
    const setupExtensions = getDefaultExtensions({
      theme: "none",
      basicSetup: BASIC_SETUP_OPTIONS,
      editable: true,
      readOnly: false,
      placeholder: "",
      indentWithTab: true,
    })
    EditorState.create({ doc: EMPTY_EDITOR_DOC, extensions: setupExtensions })
    return BASIC_SETUP_OPTIONS
  } catch {
    return false
  }
}

export function LiveSyntaxEditor({
  value,
  onChange,
  filePath,
  className,
}: LiveSyntaxEditorProps) {
  const [isDarkMode, setIsDarkMode] = useState(() => {
    if (typeof document === "undefined") return false
    return document.documentElement.classList.contains("dark")
  })

  useEffect(() => {
    if (typeof document === "undefined") return
    const root = document.documentElement
    const observer = new MutationObserver(() => {
      setIsDarkMode(root.classList.contains("dark"))
    })
    observer.observe(root, { attributes: true, attributeFilter: ["class"] })
    return () => observer.disconnect()
  }, [])

  const languageExtensions = useMemo(() => resolveLanguageExtensions(filePath), [filePath])
  const editorTheme = useMemo(() => resolveTheme(isDarkMode), [isDarkMode])
  const basicSetup = useMemo(() => resolveBasicSetup(), [])
  const lineCount = useMemo(() => value.split("\n").length, [value])
  const shouldUseSoftMax = lineCount > SOFT_MAX_VISIBLE_LINES
  const softMaxHeightPx = SOFT_MAX_VISIBLE_LINES * ESTIMATED_LINE_HEIGHT_PX + EDITOR_VERTICAL_PADDING_PX

  return (
    <CodeMirror
      value={value}
      theme={editorTheme}
      extensions={languageExtensions}
      className={cn(
        "playbook-code-editor min-h-52",
        shouldUseSoftMax && "playbook-code-editor--soft-capped",
        className,
      )}
      style={shouldUseSoftMax ? { maxHeight: `${softMaxHeightPx}px` } : undefined}
      basicSetup={basicSetup}
      onChange={(nextValue) => onChange(nextValue)}
    />
  )
}
