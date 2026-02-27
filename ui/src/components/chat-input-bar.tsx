import { useRef, useCallback, useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { cn, createClientId } from "@/lib/utils"
import {
  buildChatCommandInputValue,
  filterChatCommands,
  getSlashAutocompleteQuery,
  type ChatCommandDefinition,
} from "@/lib/chat-commands"
import { dispatchCommandAliasesChanged } from "@/lib/command-alias-events"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ArrowUpIcon, MicIcon, PlusIcon, RotateCcwIcon, SquareIcon, XIcon } from "lucide-react"

export interface ImageAttachment {
  id: string
  dataUrl: string
}

/** Max image file size in bytes (4 MB). */
const MAX_IMAGE_SIZE = 4 * 1024 * 1024
/** Max images per message. */
const MAX_IMAGES = 4
const KEY_ENTER = "Enter"
const KEY_TAB = "Tab"
const KEY_ARROW_DOWN = "ArrowDown"
const KEY_ARROW_UP = "ArrowUp"
const KEY_ESCAPE = "Escape"
const RECOGNITION_MAX_ALTERNATIVES = 1
const RECOGNITION_CONTINUOUS = false
const RECOGNITION_INTERIM_RESULTS = true
const MAX_NO_SPEECH_RETRIES = 2
const NO_SPEECH_RETRY_DELAY_MS = 200
const VOICE_RECOGNITION_ERROR_KEYS: Record<string, "chat.voiceRecordingFailed" | "chat.voicePermissionDenied" | "chat.voiceNoSpeech" | "chat.voiceRecognitionFailed" | null> = {
  "audio-capture": "chat.voiceRecordingFailed",
  aborted: null,
  network: "chat.voiceRecognitionFailed",
  "not-allowed": "chat.voicePermissionDenied",
  "service-not-allowed": "chat.voicePermissionDenied",
  "no-speech": "chat.voiceNoSpeech",
}

type AudioCaptureStatus = "idle" | "listening"

interface BrowserSpeechRecognitionResult {
  isFinal: boolean
  length: number
  [index: number]: { transcript?: string }
}

interface BrowserSpeechRecognitionEvent extends Event {
  resultIndex: number
  results: {
    length: number
    [index: number]: BrowserSpeechRecognitionResult
  }
}

interface BrowserSpeechRecognitionErrorEvent extends Event {
  error: string
}

interface BrowserSpeechRecognition extends EventTarget {
  continuous: boolean
  interimResults: boolean
  lang: string
  maxAlternatives: number
  onaudiostart: ((this: BrowserSpeechRecognition, ev: Event) => void) | null
  onspeechstart: ((this: BrowserSpeechRecognition, ev: Event) => void) | null
  onnomatch: ((this: BrowserSpeechRecognition, ev: Event) => void) | null
  onresult: ((this: BrowserSpeechRecognition, ev: BrowserSpeechRecognitionEvent) => void) | null
  onerror: ((this: BrowserSpeechRecognition, ev: BrowserSpeechRecognitionErrorEvent) => void) | null
  onend: ((this: BrowserSpeechRecognition, ev: Event) => void) | null
  start: () => void
  stop: () => void
}

type BrowserSpeechRecognitionConstructor = new () => BrowserSpeechRecognition

export interface ChatInputBarProps {
  value: string
  onChange: (value: string) => void
  onSend: (textOverride?: string) => void
  onStop?: () => void
  onClear?: () => void
  connected: boolean
  sending: boolean
  placeholder?: string
  slashCommands?: ChatCommandDefinition[]
  onAddAlias?: (alias: string, expansion: string) => Promise<void>
  images?: ImageAttachment[]
  onImagesChange?: (images: ImageAttachment[]) => void
}

function normalizeAliasNameInput(rawAlias: string): string {
  const trimmed = rawAlias.trim().toLowerCase()
  if (!trimmed) return ""
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`
}

function normalizeAliasExpansionInput(rawExpansion: string): string {
  return rawExpansion.trim().replace(/^\/+/, "")
}

/** Read a File into a base64 data URL. Rejects if file exceeds MAX_IMAGE_SIZE. */
function readImageFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (file.size > MAX_IMAGE_SIZE) {
      reject(new Error(`Image too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Max ${MAX_IMAGE_SIZE / 1024 / 1024} MB.`))
      return
    }
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error("Failed to read image"))
    reader.readAsDataURL(file)
  })
}

function appendTranscript(existingText: string, transcript: string): string {
  const trimmedExisting = existingText.trimEnd()
  const trimmedTranscript = transcript.trim()
  if (!trimmedTranscript) return trimmedExisting
  if (!trimmedExisting) return trimmedTranscript
  return `${trimmedExisting}\n${trimmedTranscript}`
}

function composeTranscriptValue(baseInput: string, finalParts: string[], interim: string): string {
  const finalTranscript = finalParts.join(" ").trim()
  const interimTranscript = interim.trim()
  const transcript = finalTranscript || interimTranscript
  return appendTranscript(baseInput, transcript)
}

function resolveRecognitionLanguage(appLanguage?: string, browserLanguage?: string): string {
  const normalizedAppLanguage = (appLanguage ?? "").toLowerCase()
  if (normalizedAppLanguage.startsWith("zh")) return "zh-CN"
  if (normalizedAppLanguage.startsWith("en")) return "en-US"
  return browserLanguage || "en-US"
}

function getSpeechRecognitionConstructor(): BrowserSpeechRecognitionConstructor | null {
  if (typeof window === "undefined") return null
  const speechWindow = window as Window & {
    SpeechRecognition?: BrowserSpeechRecognitionConstructor
    webkitSpeechRecognition?: BrowserSpeechRecognitionConstructor
  }
  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition ?? null
}

export function ChatInputBar({
  value,
  onChange,
  onSend,
  onStop,
  onClear,
  connected,
  sending,
  placeholder,
  slashCommands = [],
  onAddAlias,
  images = [],
  onImagesChange,
}: ChatInputBarProps) {
  const { t, i18n } = useTranslation()
  const placeholderText = placeholder ?? t("chat.askAnything")
  const fileInputRef = useRef<HTMLInputElement>(null)
  const lastSubmittedSignatureRef = useRef<string | null>(null)
  const inputValueRef = useRef(value)
  const speechRecognitionRef = useRef<BrowserSpeechRecognition | null>(null)
  const recognitionBaseInputRef = useRef("")
  const transcriptPartsRef = useRef<string[]>([])
  const interimTranscriptRef = useRef("")
  const hasRecognitionResultRef = useRef(false)
  const didDetectAudioRef = useRef(false)
  const didDetectSpeechRef = useRef(false)
  const lastRecognitionErrorRef = useRef<string | null>(null)
  const manualStopRequestedRef = useRef(false)
  const microphoneAccessReadyRef = useRef(false)
  const noSpeechRetryCountRef = useRef(0)
  const noSpeechRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [activeCommandIndex, setActiveCommandIndex] = useState(0)
  const [dismissedAutocompleteValue, setDismissedAutocompleteValue] = useState<string | null>(null)
  const [addAliasOpen, setAddAliasOpen] = useState(false)
  const [addAliasSaving, setAddAliasSaving] = useState(false)
  const [addAliasError, setAddAliasError] = useState<string | null>(null)
  const [aliasNameDraft, setAliasNameDraft] = useState("")
  const [aliasExpansionDraft, setAliasExpansionDraft] = useState("")
  const [audioCaptureStatus, setAudioCaptureStatus] = useState<AudioCaptureStatus>("idle")
  const [audioError, setAudioError] = useState<string | null>(null)
  const trimmedValue = value.trim()
  const hasContent = trimmedValue.length > 0 || images.length > 0
  const shouldShowStopButton = sending && trimmedValue.length === 0 && images.length === 0 && Boolean(onStop)
  const slashQuery = useMemo(() => getSlashAutocompleteQuery(value), [value])
  const commandSuggestions = useMemo(
    () => (slashQuery === null ? [] : filterChatCommands(slashQuery, slashCommands)),
    [slashQuery, slashCommands],
  )
  const hasCommandSuggestions = commandSuggestions.length > 0
  const isAutocompleteDismissed = dismissedAutocompleteValue === value
  const shouldShowCommandAutocomplete =
    slashQuery !== null && !isAutocompleteDismissed && (hasCommandSuggestions || Boolean(onAddAlias))
  const recognitionConstructor = useMemo(() => getSpeechRecognitionConstructor(), [])
  const canRecordAudio = recognitionConstructor !== null

  inputValueRef.current = value
  const addImages = useCallback(
    async (files: File[]) => {
      const remaining = MAX_IMAGES - images.length
      if (remaining <= 0) return
      const toProcess = files.slice(0, remaining)
      const newImages: ImageAttachment[] = []
      for (const file of toProcess) {
        if (!file.type.startsWith("image/")) continue
        try {
          const dataUrl = await readImageFile(file)
          newImages.push({ id: createClientId(), dataUrl })
        } catch {
          // Skip files that are too large or fail to read
        }
      }
      if (newImages.length > 0) {
        onImagesChange?.([...images, ...newImages])
      }
    },
    [images, onImagesChange],
  )

  const stopVoiceRecording = useCallback(() => {
    const recognition = speechRecognitionRef.current
    if (recognition) recognition.stop()
  }, [])

  const ensureMicrophoneAccess = useCallback(async (): Promise<boolean> => {
    if (microphoneAccessReadyRef.current) return true
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) return true
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      for (const track of stream.getTracks()) track.stop()
      microphoneAccessReadyRef.current = true
      return true
    } catch {
      setAudioError(t("chat.voicePermissionDenied"))
      return false
    }
  }, [t])

  const startVoiceRecording = useCallback(async (
    preserveTranscript = false,
    preserveNoSpeechRetryCount = false,
  ) => {
    if (!recognitionConstructor || !canRecordAudio || !connected || sending) return
    if (speechRecognitionRef.current) return

    if (noSpeechRetryTimerRef.current) {
      clearTimeout(noSpeechRetryTimerRef.current)
      noSpeechRetryTimerRef.current = null
    }

    const hasMicrophoneAccess = await ensureMicrophoneAccess()
    if (!hasMicrophoneAccess) {
      setAudioCaptureStatus("idle")
      return
    }

    const recognition = new recognitionConstructor()
    manualStopRequestedRef.current = false
    if (!preserveTranscript) {
      recognitionBaseInputRef.current = inputValueRef.current
      transcriptPartsRef.current = []
      interimTranscriptRef.current = ""
      hasRecognitionResultRef.current = false
    }
    didDetectAudioRef.current = false
    didDetectSpeechRef.current = false
    lastRecognitionErrorRef.current = null
    if (!preserveNoSpeechRetryCount) {
      noSpeechRetryCountRef.current = 0
    }
    setAudioError(null)

    recognition.lang = resolveRecognitionLanguage(i18n.resolvedLanguage ?? i18n.language, navigator.language)
    recognition.continuous = RECOGNITION_CONTINUOUS
    recognition.interimResults = RECOGNITION_INTERIM_RESULTS
    recognition.maxAlternatives = RECOGNITION_MAX_ALTERNATIVES
    recognition.onaudiostart = () => {
      didDetectAudioRef.current = true
    }
    recognition.onspeechstart = () => {
      didDetectSpeechRef.current = true
    }
    recognition.onnomatch = () => {
      didDetectSpeechRef.current = true
    }

    recognition.onresult = (event) => {
      didDetectSpeechRef.current = true
      let interimTranscript = ""
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index]
        const transcript = result[0]?.transcript?.trim()
        if (!transcript) continue
        if (result.isFinal) {
          transcriptPartsRef.current.push(transcript)
          continue
        }
        interimTranscript = transcript
      }
      interimTranscriptRef.current = interimTranscript
      const nextValue = composeTranscriptValue(
        recognitionBaseInputRef.current,
        transcriptPartsRef.current,
        interimTranscriptRef.current,
      )
      if (nextValue.trim() !== recognitionBaseInputRef.current.trim()) {
        hasRecognitionResultRef.current = true
        onChange(nextValue)
      }
    }

    recognition.onerror = (event) => {
      lastRecognitionErrorRef.current = event.error
      if (event.error === "no-speech") return
      const key = VOICE_RECOGNITION_ERROR_KEYS[event.error] ?? "chat.voiceRecognitionFailed"
      if (key === null) return
      setAudioError(t(key))
    }

    recognition.onend = () => {
      void (async () => {
        const finalTranscript = transcriptPartsRef.current.join(" ").trim()
        const transcript = finalTranscript || interimTranscriptRef.current.trim()
        speechRecognitionRef.current = null
        const shouldRetryNoSpeech =
          !manualStopRequestedRef.current &&
          !transcript &&
          !hasRecognitionResultRef.current &&
          lastRecognitionErrorRef.current === "no-speech" &&
          noSpeechRetryCountRef.current < MAX_NO_SPEECH_RETRIES
        if (shouldRetryNoSpeech) {
          noSpeechRetryCountRef.current += 1
          noSpeechRetryTimerRef.current = setTimeout(() => {
            noSpeechRetryTimerRef.current = null
            void startVoiceRecording(true, true)
          }, NO_SPEECH_RETRY_DELAY_MS)
          return
        }

        setAudioCaptureStatus("idle")
        if (!transcript) {
          transcriptPartsRef.current = []
          interimTranscriptRef.current = ""
          if (!manualStopRequestedRef.current && !hasRecognitionResultRef.current) {
            if (lastRecognitionErrorRef.current && lastRecognitionErrorRef.current !== "no-speech") {
              const key = VOICE_RECOGNITION_ERROR_KEYS[lastRecognitionErrorRef.current] ?? "chat.voiceRecognitionFailed"
              if (key) setAudioError(t(key))
            } else if (didDetectSpeechRef.current || didDetectAudioRef.current) {
              setAudioError(t("chat.voiceRecognitionFailed"))
            } else {
              setAudioError(t("chat.voiceNoSpeech"))
            }
          }
          return
        }

        noSpeechRetryCountRef.current = 0
        const finalValue = composeTranscriptValue(recognitionBaseInputRef.current, [transcript], "")
        onChange(finalValue)
        setAudioError(null)
        transcriptPartsRef.current = []
        interimTranscriptRef.current = ""
      })()
    }

    try {
      speechRecognitionRef.current = recognition
      setAudioCaptureStatus("listening")
      recognition.start()
    } catch {
      speechRecognitionRef.current = null
      setAudioCaptureStatus("idle")
      microphoneAccessReadyRef.current = false
      setAudioError(t("chat.voiceRecognitionFailed"))
    }
  }, [
    canRecordAudio,
    connected,
    ensureMicrophoneAccess,
    i18n.language,
    i18n.resolvedLanguage,
    onChange,
    recognitionConstructor,
    sending,
    t,
  ])

  function handleVoiceInputClick() {
    if (audioCaptureStatus === "listening") {
      manualStopRequestedRef.current = true
      if (noSpeechRetryTimerRef.current) {
        clearTimeout(noSpeechRetryTimerRef.current)
        noSpeechRetryTimerRef.current = null
      }
      stopVoiceRecording()
      return
    }
    void startVoiceRecording()
  }

  useEffect(() => {
    if (!hasContent) {
      lastSubmittedSignatureRef.current = null
    }
  }, [hasContent])

  useEffect(() => {
    if (dismissedAutocompleteValue === null) return
    if (value === dismissedAutocompleteValue) return
    setDismissedAutocompleteValue(null)
  }, [dismissedAutocompleteValue, value])

  useEffect(
    () => () => {
      if (noSpeechRetryTimerRef.current) {
        clearTimeout(noSpeechRetryTimerRef.current)
        noSpeechRetryTimerRef.current = null
      }
      const recognition = speechRecognitionRef.current
      if (recognition) {
        recognition.onaudiostart = null
        recognition.onspeechstart = null
        recognition.onnomatch = null
        recognition.onresult = null
        recognition.onerror = null
        recognition.onend = null
        recognition.stop()
        speechRecognitionRef.current = null
      }
    },
    [],
  )

  const normalizedActiveCommandIndex = commandSuggestions.length > 0
    ? Math.min(activeCommandIndex, commandSuggestions.length - 1)
    : 0

  function submitOncePerInputState(textOverride?: string) {
    const textToSend = textOverride?.trim() ?? trimmedValue
    const hasSubmissionContent = textToSend.length > 0 || images.length > 0
    if (!hasSubmissionContent) return
    const imageSignature = images.map((img) => img.id).join(",")
    const signature = `${textToSend}::${imageSignature}`
    if (lastSubmittedSignatureRef.current === signature) return
    lastSubmittedSignatureRef.current = signature
    onSend(textOverride)
  }

  function selectCommandSuggestion(command: ChatCommandDefinition) {
    onChange(buildChatCommandInputValue(command))
  }

  function openAddAliasDialog() {
    setAddAliasError(null)
    setAliasNameDraft(slashQuery ?? "")
    setAliasExpansionDraft("")
    setAddAliasOpen(true)
  }

  async function handleSaveAlias() {
    if (!onAddAlias) return
    const alias = normalizeAliasNameInput(aliasNameDraft)
    const expansion = normalizeAliasExpansionInput(aliasExpansionDraft)
    if (!alias || !expansion) return

    setAddAliasSaving(true)
    try {
      await onAddAlias(alias, expansion)
      dispatchCommandAliasesChanged()
      setAddAliasOpen(false)
      setAddAliasError(null)
    } catch (err) {
      const message = err instanceof Error ? err.message : t("settings.aliasesSaveFailed")
      setAddAliasError(message)
    } finally {
      setAddAliasSaving(false)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (shouldShowCommandAutocomplete) {
      if (e.key === KEY_ESCAPE) {
        e.preventDefault()
        setDismissedAutocompleteValue(value)
        return
      }
      if (!hasCommandSuggestions) return
      if (e.key === KEY_ARROW_DOWN) {
        e.preventDefault()
        setActiveCommandIndex((current) => {
          const currentIndex = Math.min(current, commandSuggestions.length - 1)
          return (currentIndex + 1) % commandSuggestions.length
        })
        return
      }
      if (e.key === KEY_ARROW_UP) {
        e.preventDefault()
        setActiveCommandIndex((current) => {
          const currentIndex = Math.min(current, commandSuggestions.length - 1)
          return (currentIndex - 1 + commandSuggestions.length) % commandSuggestions.length
        })
        return
      }
      if (e.key === KEY_TAB) {
        e.preventDefault()
        const activeCommand = commandSuggestions[normalizedActiveCommandIndex]
        if (activeCommand) selectCommandSuggestion(activeCommand)
        return
      }
      if (e.key === KEY_ENTER && !e.shiftKey && !e.repeat) {
        const activeCommand = commandSuggestions[normalizedActiveCommandIndex]
        if (activeCommand) {
          e.preventDefault()
          submitOncePerInputState(activeCommand.command)
          return
        }
      }
    }

    if (e.key === KEY_ENTER && !e.shiftKey && !e.repeat) {
      e.preventDefault()
      submitOncePerInputState()
    }
  }

  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = Array.from(e.clipboardData.items)
    const imageFiles = items
      .filter((item) => item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((f): f is File => f !== null)
    if (imageFiles.length > 0) {
      e.preventDefault()
      void addImages(imageFiles)
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    if (files.length > 0) void addImages(files)
    // Reset so picking the same file again triggers onChange
    e.target.value = ""
  }

  function removeImage(id: string) {
    onImagesChange?.(images.filter((img) => img.id !== id))
  }

  function handlePrimaryButtonClick() {
    if (shouldShowStopButton) {
      onStop?.()
      return
    }
    submitOncePerInputState()
  }

  const isRecordingAudio = audioCaptureStatus === "listening"
  const voiceButtonLabel = isRecordingAudio
    ? t("chat.stopRecording")
    : t("chat.recordVoice")

  return (
    <div data-slot="chat-input" className="mx-auto w-full max-w-4xl px-3 pb-3 pt-2 sm:px-4 sm:pb-4">
      <div className="relative">
        {shouldShowCommandAutocomplete && (
          <div className="absolute inset-x-2 bottom-full z-20 mb-2">
            <div className="overflow-hidden rounded-2xl border border-border bg-popover text-popover-foreground shadow-2xl ring-1 ring-foreground/5">
              <div className="border-b border-border/70 px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-medium text-muted-foreground">{t("chat.slashCommands.title")}</p>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-xs"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={openAddAliasDialog}
                    disabled={!onAddAlias}
                  >
                    {t("settings.addAlias")}
                  </Button>
                </div>
              </div>
              <div className="p-1.5">
              {hasCommandSuggestions ? commandSuggestions.map((command, index) => {
                const isActive = index === normalizedActiveCommandIndex
                return (
                  <Button
                    key={command.command}
                    type="button"
                    variant="ghost"
                    size="sm"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => submitOncePerInputState(command.command)}
                    className={cn(
                      "group/command h-auto w-full justify-start rounded-xl px-2.5 py-2 text-left",
                      isActive
                        ? "bg-accent text-accent-foreground hover:bg-accent hover:text-accent-foreground"
                        : "text-foreground hover:bg-muted/70 hover:text-foreground",
                    )}
                  >
                    <span className="grid min-w-0 grid-cols-[auto_1fr] items-center gap-2.5">
                      <span
                        className={cn(
                          "rounded-md border border-border bg-muted px-1.5 py-0.5 text-xs font-semibold text-foreground",
                        )}
                      >
                        {command.command}
                      </span>
                      <span
                        className={cn(
                          "min-w-0 truncate text-xs",
                          isActive
                            ? "text-accent-foreground/80"
                            : "text-muted-foreground group-hover/command:text-foreground/80",
                        )}
                      >
                        {command.description}
                      </span>
                    </span>
                  </Button>
                )
              }) : (
                <p className="px-2.5 py-2 text-xs text-muted-foreground">
                  {t("chat.slashCommands.emptyAliases")}
                </p>
              )}
              </div>
            </div>
          </div>
        )}
        <div className="flex flex-col gap-2 rounded-4xl border border-border bg-muted/50 py-1.5 pr-1.5 pl-1.5">
          {/* Image preview strip */}
          {images.length > 0 && (
            <div className="flex gap-2 overflow-x-auto px-2 pt-1">
              {images.map((img) => (
                <div key={img.id} className="group relative">
                  <img
                    src={img.dataUrl}
                    alt="attachment"
                    className="size-16 rounded-lg object-cover"
                  />
                  <button
                    type="button"
                    onClick={() => removeImage(img.id)}
                    aria-label="Remove image"
                    className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full bg-foreground/80 text-background opacity-0 transition-opacity group-hover:opacity-100"
                  >
                    <XIcon className="size-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
          {/* Input row */}
          <div className="flex items-end gap-1">
            {onClear && (
              <Button
                onClick={onClear}
                disabled={!connected || sending}
                variant="ghost"
                size="icon"
                aria-label={t("chat.clearSession")}
                title={t("chat.clearSession")}
                className="size-9 shrink-0 rounded-full text-muted-foreground hover:text-foreground"
              >
                <RotateCcwIcon className="size-4" />
              </Button>
            )}
            <Button
              onClick={() => fileInputRef.current?.click()}
              disabled={!connected || sending || images.length >= MAX_IMAGES}
              variant="ghost"
              size="icon"
              aria-label={t("chat.attachImage")}
              title={t("chat.attachImage")}
              className="size-9 shrink-0 rounded-full text-muted-foreground hover:text-foreground"
            >
              <PlusIcon className="size-4" />
            </Button>
            {canRecordAudio && (
              <Button
                onClick={handleVoiceInputClick}
                disabled={!connected || sending}
                variant="ghost"
                size="icon"
                aria-label={voiceButtonLabel}
                title={voiceButtonLabel}
                className={cn(
                  "size-9 shrink-0 rounded-full text-muted-foreground hover:text-foreground",
                  isRecordingAudio && "bg-foreground text-background hover:bg-foreground/90 hover:text-background",
                )}
              >
                {isRecordingAudio
                  ? <SquareIcon className="size-3 fill-current stroke-current" />
                  : <MicIcon className="size-4" />}
              </Button>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={handleFileChange}
            />
            <Textarea
              autoFocus
              rows={1}
              value={value}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={placeholderText}
              disabled={!connected}
              className="min-h-9 max-h-36 flex-1 resize-none overflow-y-auto border-0 bg-transparent px-1 py-2 text-sm shadow-none focus-visible:ring-0"
            />
            <Button
              onClick={handlePrimaryButtonClick}
              disabled={shouldShowStopButton ? !connected : !connected || !hasContent}
              size="icon"
              aria-label={shouldShowStopButton ? t("chat.stopGenerating") : t("chat.sendMessage")}
              title={shouldShowStopButton ? t("chat.stopGenerating") : t("chat.sendMessage")}
              className={cn(
                "size-9 shrink-0 rounded-full transition-opacity",
                shouldShowStopButton && "bg-foreground text-background hover:bg-foreground/90",
                shouldShowStopButton || hasContent ? "opacity-100" : "opacity-40",
              )}
            >
              {shouldShowStopButton ? (
                <SquareIcon className="size-3 fill-current stroke-current" />
              ) : (
                <ArrowUpIcon className="size-4.5" />
              )}
            </Button>
          </div>
          {audioError && (
            <p className="px-3 pb-1 text-xs text-destructive">{audioError}</p>
          )}
        </div>
      </div>
      <Dialog open={addAliasOpen} onOpenChange={setAddAliasOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{t("settings.addAlias")}</DialogTitle>
            <DialogDescription>{t("settings.commandAliasModalHelp")}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="chat-add-alias-name" className="text-sm font-medium text-foreground">
                {t("settings.aliasName")}
              </label>
              <Input
                id="chat-add-alias-name"
                value={aliasNameDraft}
                onChange={(event) => setAliasNameDraft(event.target.value)}
                placeholder={t("settings.aliasNamePlaceholder")}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="chat-add-alias-expansion" className="text-sm font-medium text-foreground">
                {t("settings.aliasExpansion")}
              </label>
              <Textarea
                id="chat-add-alias-expansion"
                rows={8}
                value={aliasExpansionDraft}
                onChange={(event) => setAliasExpansionDraft(event.target.value)}
                placeholder={t("settings.aliasExpansionPlaceholder")}
              />
            </div>
            {addAliasError && (
              <p className="text-sm text-destructive">{addAliasError}</p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setAddAliasOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              onClick={() => { void handleSaveAlias() }}
              disabled={addAliasSaving || aliasNameDraft.trim().length === 0 || aliasExpansionDraft.trim().length === 0}
            >
              {t("settings.saveAlias")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
