import { describe, expect, it } from "vitest"
import { buildInlineQuestionLayout, parseCommentQuestions } from "./comment-question-block.js"

describe("comment question block parsing", () => {
  it("supports question-level type after options", () => {
    const parsed = parseCommentQuestions(`
Before

\`\`\`question
title: Pick movie types
options:
- Comedy
- Mystery
type: multi
\`\`\`
`)

    expect(parsed.questions).toHaveLength(1)
    expect(parsed.questions[0]?.type).toBe("multi")
    expect(parsed.questions[0]?.options.map((option) => option.label)).toEqual(["Comedy", "Mystery"])
  })

  it("returns markdown/question segments in original order", () => {
    const parsed = parseCommentQuestions(`
### 1. Data type: INTEGER vs. existing pattern
Use nullable estimate for cleaner semantics.

\`\`\`question
title: How to represent "no estimate"?
options:
- NULL in DB / *int nil in Go
- 0 in DB / int 0 in Go
\`\`\`

### 2. Stats command — does it exist yet?
No stats command is in the codebase today.

\`\`\`question
title: Should Task 7 include building stats?
options:
- Yes
- No
\`\`\`
`)

    expect(parsed.questions).toHaveLength(2)
    expect(parsed.segments.map((segment) => segment.type)).toEqual([
      "markdown",
      "question",
      "markdown",
      "question",
    ])
    expect(parsed.segments[0]).toMatchObject({
      type: "markdown",
      content: expect.stringContaining("### 1. Data type"),
    })
    expect(parsed.segments[2]).toMatchObject({
      type: "markdown",
      content: expect.stringContaining("### 2. Stats command"),
    })
    expect(parsed.segments[1]).toMatchObject({
      type: "question",
      question: { title: 'How to represent "no estimate"?' },
    })
    expect(parsed.segments[3]).toMatchObject({
      type: "question",
      question: { title: "Should Task 7 include building stats?" },
    })
  })

  it("keeps non-question markdown content unmodified", () => {
    const content = [
      "Intro paragraph.",
      "",
      "",
      "",
      "```ts",
      "const answer = 42",
      "",
      "",
      "console.log(answer)",
      "```",
      "",
      "Tail paragraph.",
    ].join("\n")

    const parsed = parseCommentQuestions(content)
    const inlineLayout = buildInlineQuestionLayout(parsed)

    expect(parsed.questions).toHaveLength(0)
    expect(parsed.markdown).toBe(content)
    expect(parsed.segments).toEqual([{ type: "markdown", content }])
    expect(inlineLayout.markdownSegments).toEqual([{ type: "markdown", content }])
    expect(inlineLayout.questions).toEqual([])
  })

  it("keeps malformed question blocks as markdown", () => {
    const parsed = parseCommentQuestions(`
Before

\`\`\`question
title: Missing options should not be dropped
\`\`\`

After
    `)

    expect(parsed.questions).toHaveLength(0)
    expect(parsed.segments.every((segment) => segment.type === "markdown")).toBe(true)
    expect(parsed.markdown).toContain("Before")
    expect(parsed.markdown).toContain("Missing options should not be dropped")
    expect(parsed.markdown).toContain("After")
  })

  it("preserves unnumbered pre-question markdown in the markdown stream", () => {
    const parsed = parseCommentQuestions(`
Intro details should stay outside the question card.

\`\`\`question
title: Confirm approach
options:
- Keep it
- Change it
\`\`\`

Outro note should stay after the question.
`)

    const inlineLayout = buildInlineQuestionLayout(parsed)
    expect(inlineLayout.questions).toHaveLength(1)
    expect(inlineLayout.questions[0]).toMatchObject({
      title: "Confirm approach",
    })
    expect(inlineLayout.questions[0]?.contextTitle).toBeUndefined()
    expect(inlineLayout.questions[0]?.contextBody).toBeUndefined()
    expect(inlineLayout.markdownSegments).toHaveLength(2)
    expect(inlineLayout.markdownSegments[0]?.content).toContain(
      "Intro details should stay outside the question card.",
    )
    expect(inlineLayout.markdownSegments[1]?.content).toContain(
      "Outro note should stay after the question.",
    )
  })

  it("builds a single inline questionnaire with per-question context from markdown segments", () => {
    const parsed = parseCommentQuestions(`
## Planning Review
Intro note before the questions.

### 1. Data type: INTEGER vs. pattern
Should no estimate be NULL or 0?
\`\`\`question
title: How to represent "no estimate"?
options:
- NULL
- 0
\`\`\`

### 2. Stats command — does it exist yet?
There is no stats command in the codebase today.
\`\`\`question
title: Should Task 7 include building stats?
options:
- Yes
- No
\`\`\`
`)

    const inlineLayout = buildInlineQuestionLayout(parsed)
    expect(inlineLayout.questions).toHaveLength(2)
    expect(inlineLayout.questions[0]).toMatchObject({
      title: 'How to represent "no estimate"?',
      contextTitle: "Data type: INTEGER vs. pattern",
      contextBody: "Should no estimate be NULL or 0?",
    })
    expect(inlineLayout.questions[1]).toMatchObject({
      title: "Should Task 7 include building stats?",
      contextTitle: "Stats command — does it exist yet?",
      contextBody: "There is no stats command in the codebase today.",
    })
    expect(inlineLayout.markdownSegments).toHaveLength(1)
    expect(inlineLayout.markdownSegments[0]?.content).toContain("## Planning Review")
    expect(inlineLayout.markdownSegments[0]?.content).toContain("Intro note before the questions.")
  })

  it("does not leave standalone thematic breaks between extracted question sections", () => {
    const parsed = parseCommentQuestions(`
## Planning — Round 1 Questions
Intro text before questions.

---
### 1. Saved Views — \`--assignee me\` resolution
When creating a view with \`--assignee me\`, should \`me\` be stored literally?
\`\`\`question
title: Saved Views resolution
options:
- Store literal me
- Resolve at creation time
\`\`\`

---
### 2. Stats command — does it exist yet?
No stats command exists today.
\`\`\`question
title: Should Task 7 include stats?
options:
- Yes
- No
\`\`\`
`)

    const inlineLayout = buildInlineQuestionLayout(parsed)
    expect(inlineLayout.questions).toHaveLength(2)
    expect(inlineLayout.markdownSegments).toHaveLength(1)
    expect(inlineLayout.markdownSegments[0]?.content).not.toMatch(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/m)
    expect(inlineLayout.markdownSegments[0]?.content).toContain("## Planning — Round 1 Questions")
    expect(inlineLayout.questions[0]).toMatchObject({
      contextTitle: "Saved Views — `--assignee me` resolution",
    })
    expect(inlineLayout.questions[1]).toMatchObject({
      contextTitle: "Stats command — does it exist yet?",
    })
  })
})
