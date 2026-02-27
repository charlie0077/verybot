import { useMemo } from "react"
import { XIcon } from "lucide-react"
import { useAttachmentSrc } from "@/hooks/use-attachment-src"
import { toSanitizedMarkdownHtml } from "@/lib/markdown"
import { cn } from "@/lib/utils"
import { parseInlineDescription } from "./inline-image-markdown"

const DEFAULT_TEXT_CLASS_NAME = "text-sm text-foreground"
const DEFAULT_IMAGE_CONTAINER_CLASS_NAME = "group relative my-2 block overflow-hidden rounded-md border border-border"
const DEFAULT_IMAGE_CLASS_NAME = "max-h-96 w-full object-cover"

export interface TaskDescriptionMarkdownProps {
  description: string
  className?: string
  textClassName?: string
  imageContainerClassName?: string
  imageClassName?: string
  onRemoveImage?: (attachmentId: string) => void
  removeImageAriaLabel?: string
}

export function TaskDescriptionMarkdown({
  description,
  className,
  textClassName = DEFAULT_TEXT_CLASS_NAME,
  imageContainerClassName = DEFAULT_IMAGE_CONTAINER_CLASS_NAME,
  imageClassName = DEFAULT_IMAGE_CLASS_NAME,
  onRemoveImage,
  removeImageAriaLabel,
}: TaskDescriptionMarkdownProps) {
  const segments = useMemo(
    () => parseInlineDescription(description),
    [description],
  )

  if (segments.length === 0) return null

  return (
    <div className={cn("markdown-body break-words text-foreground", className)}>
      {segments.map((segment, index) => {
        if (segment.type === "text") {
          return (
            <MarkdownTextSegment
              key={`text-${index}`}
              text={segment.text}
              className={textClassName}
            />
          )
        }

        return (
          <MarkdownAttachmentImage
            key={`image-${segment.attachmentId}-${index}`}
            attachmentId={segment.attachmentId}
            alt={segment.alt}
            className={imageContainerClassName}
            imageClassName={imageClassName}
            onRemoveImage={onRemoveImage}
            removeImageAriaLabel={removeImageAriaLabel}
          />
        )
      })}
    </div>
  )
}

function MarkdownTextSegment({ text, className }: { text: string; className: string }) {
  const html = useMemo(
    () => toSanitizedMarkdownHtml(text),
    [text],
  )

  if (!html) return null

  return (
    <div
      className={className}
      // Sanitization happens in toSanitizedMarkdownHtml().
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

interface MarkdownAttachmentImageProps {
  attachmentId: string
  alt: string
  className: string
  imageClassName: string
  onRemoveImage?: (attachmentId: string) => void
  removeImageAriaLabel?: string
}

function MarkdownAttachmentImage({
  attachmentId,
  alt,
  className,
  imageClassName,
  onRemoveImage,
  removeImageAriaLabel,
}: MarkdownAttachmentImageProps) {
  const src = useAttachmentSrc(attachmentId)

  return (
    <div className={className}>
      {src
        ? <img src={src} alt={alt} className={imageClassName} />
        : <span className="block aspect-video w-full animate-pulse bg-muted" />}
      {onRemoveImage && removeImageAriaLabel && (
        <button
          type="button"
          aria-label={removeImageAriaLabel}
          onClick={() => onRemoveImage(attachmentId)}
          className="absolute top-2 right-2 hidden size-5 items-center justify-center rounded-full bg-background/90 text-foreground ring-1 ring-border group-hover:flex"
        >
          <XIcon className="size-3" />
        </button>
      )}
    </div>
  )
}
