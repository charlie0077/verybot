export const MAX_TASK_IMAGE_UPLOAD_BYTES = 10 * 1024 * 1024

const SUPPORTED_TASK_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
])

export function isSupportedTaskImageType(type: string): boolean {
  return SUPPORTED_TASK_IMAGE_TYPES.has(type)
}

/** Reads a File as a base64 string (data portion only). */
export function taskImageFileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      resolve(result.split(",")[1])
    }
    reader.onerror = () => reject(new Error("Failed to read file"))
    reader.readAsDataURL(file)
  })
}

/** Extract clipboard image files from paste events. */
export function extractClipboardImageFiles(clipboardData: DataTransfer | null): File[] {
  if (!clipboardData) return []

  return Array.from(clipboardData.items)
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null)
}

