import { useState, useRef, useCallback } from "react"
import { useTranslation } from "react-i18next"
import { ImagePlusIcon, XIcon, LoaderIcon } from "lucide-react"
import { useGatewayContext } from "@/contexts/gateway-context"
import { useAttachmentSrc } from "@/hooks/use-attachment-src"
import { cn } from "@/lib/utils"
import type { TaskAttachment } from "./types"

const MAX_FILE_SIZE = 10 * 1024 * 1024
const ACCEPTED_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])

interface ImageUploadProps {
  attachments: TaskAttachment[]
  onChange: (attachments: TaskAttachment[]) => void
}

/** Reads a File as a base64 string (data portion only). */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      // Strip the data URL prefix ("data:image/png;base64,...")
      resolve(result.split(",")[1])
    }
    reader.onerror = () => reject(new Error("Failed to read file"))
    reader.readAsDataURL(file)
  })
}

export function ImageUpload({ attachments, onChange }: ImageUploadProps) {
  const { t } = useTranslation()
  const { rpc } = useGatewayContext()
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const uploadFile = useCallback(async (file: File) => {
    if (!ACCEPTED_TYPES.has(file.type)) {
      setError(t("tasks.imageTypeNotSupported"))
      return
    }
    if (file.size > MAX_FILE_SIZE) {
      setError(t("tasks.imageTooLarge"))
      return
    }

    setError(null)
    setUploading(true)
    try {
      const data = await fileToBase64(file)
      const attachment = await rpc("tasks.uploadAttachment", {
        name: file.name,
        type: file.type,
        data,
      }) as TaskAttachment
      onChange([...attachments, attachment])
    } catch {
      setError(t("tasks.uploadFailed"))
    } finally {
      setUploading(false)
    }
  }, [rpc, attachments, onChange, t])

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) uploadFile(file)
    e.target.value = ""
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    const file = e.dataTransfer.files[0]
    if (file) uploadFile(file)
  }

  function handleRemove(id: string) {
    onChange(attachments.filter((a) => a.id !== id))
  }

  return (
    <div className="flex flex-col gap-2">
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {attachments.map((att) => (
            <div key={att.id} className="group relative size-16 rounded-md ring-1 ring-border">
              <AttachmentThumbnail id={att.id} alt={att.name} />
              <button
                type="button"
                aria-label={t("common.remove")}
                onClick={() => handleRemove(att.id)}
                className="absolute -right-1 -top-1 hidden group-hover:flex size-4 items-center justify-center rounded-full bg-destructive text-destructive-foreground"
              >
                <XIcon className="size-2.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div
        role="button"
        tabIndex={0}
        onDragOver={(e) => e.preventDefault()}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") fileInputRef.current?.click() }}
        className={cn(
          "flex cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed border-border py-2 px-3 text-xs text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground",
          uploading && "pointer-events-none opacity-50",
        )}
      >
        {uploading ? (
          <LoaderIcon className="size-3.5 animate-spin" />
        ) : (
          <ImagePlusIcon className="size-3.5" />
        )}
        <span>{uploading ? t("common.loading") : t("tasks.addImage")}</span>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        className="hidden"
        onChange={handleFileSelect}
      />

      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}

/** Small thumbnail that loads attachment via RPC. */
function AttachmentThumbnail({ id, alt }: { id: string; alt: string }) {
  const src = useAttachmentSrc(id)
  if (!src) return <div className="size-full animate-pulse rounded-md bg-muted" />
  return <img src={src} alt={alt} className="size-full rounded-md object-cover" />
}
