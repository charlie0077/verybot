export const FONT_SIZE_KEY = "verybot-font-size"
export const DEFAULT_FONT_SIZE = "base"
export const FONT_SIZE_OPTIONS = [
  { value: "sm", labelKey: "fontSize.sm" },
  { value: "base", labelKey: "fontSize.base" },
  { value: "lg", labelKey: "fontSize.lg" },
  { value: "xl", labelKey: "fontSize.xl" },
] as const
export type FontSizeOption = (typeof FONT_SIZE_OPTIONS)[number]["value"]

/** Map font-size option to Tailwind text class for chat messages. */
export const FONT_SIZE_CLASS: Record<FontSizeOption, string> = {
  sm: "text-sm",
  base: "text-base",
  lg: "text-lg",
  xl: "text-xl",
}

const VALID_OPTIONS = new Set<string>(FONT_SIZE_OPTIONS.map((o) => o.value))

/** Type-guard: returns the value if valid, otherwise the default. */
export function validFontSize(val: string): FontSizeOption {
  return VALID_OPTIONS.has(val) ? (val as FontSizeOption) : DEFAULT_FONT_SIZE
}
