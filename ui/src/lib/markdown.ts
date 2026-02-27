import DOMPurify from "dompurify"
import { marked } from "marked"

marked.setOptions({
  gfm: true,
  breaks: true,
})

const ALLOWED_TAGS = [
  "a",
  "b",
  "blockquote",
  "br",
  "code",
  "del",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "hr",
  "i",
  "li",
  "ol",
  "p",
  "pre",
  "strong",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
]

const ALLOWED_ATTRS = [
  "class",
  "href",
  "rel",
  "start",
  "target",
  "title",
]

let hooksInstalled = false

function installHooks() {
  if (hooksInstalled) return
  hooksInstalled = true

  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node instanceof HTMLAnchorElement) {
      const href = node.getAttribute("href")
      if (!href) return
      node.setAttribute("rel", "noreferrer noopener")
      node.setAttribute("target", "_blank")
    }
  })
}

export function toSanitizedMarkdownHtml(markdown: string): string {
  const input = markdown.trim()
  if (!input) return ""

  installHooks()

  // marked.parse() is synchronous when no async extensions are configured.
  const rendered = marked.parse(input) as string
  return DOMPurify.sanitize(rendered, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ALLOWED_ATTRS,
  })
}

export function toSanitizedMarkdownInlineHtml(markdown: string): string {
  if (!markdown) return ""

  installHooks()

  const rendered = marked.parseInline(markdown) as string
  return DOMPurify.sanitize(rendered, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ALLOWED_ATTRS,
  })
}
