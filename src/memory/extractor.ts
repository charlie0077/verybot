import { generateText, type LanguageModel, type ModelMessage } from "ai";
import { logger } from "../logger.js";

const MAX_RECENT_MESSAGES = 10;

interface ExtractFactOptions {
  /** If set, only return facts related to this topic. */
  topic?: string;
  /** Number of recent messages to inspect. */
  maxMessages?: number;
}

function buildExtractionPrompt(topic?: string): string {
  const topicSection = topic
    ? `\nFOCUS MODE:
- Only include facts directly related to this topic: "${topic}".
- If no relevant facts are found for this topic, return [].
`
    : "";

  return `You extract memorable facts from conversations.

Review the conversation and identify facts worth remembering long-term about the user.${topicSection}

INCLUDE:
- Personal preferences (likes, dislikes, habits)
- Important context (name, job, location, family, timezone)
- Goals, projects, and recurring topics
- Communication preferences

EXCLUDE:
- Transient requests ("search for X", "open this URL")
- Generic small talk or greetings
- Tool usage details or technical artifacts
- Information the user explicitly asked to forget

Return ONLY a JSON array of short fact strings. Each fact should be a single sentence.
If there are no memorable facts, return an empty array: []

Example output:
["User's name is Alice", "User prefers dark mode", "User works as a backend engineer"]`;
}

/**
 * Extract memorable facts from a conversation using an LLM.
 * Returns an array of fact strings, or empty if nothing worth remembering.
 */
export async function extractFacts(
  model: LanguageModel,
  messages: ModelMessage[],
  options: ExtractFactOptions = {},
): Promise<string[]> {
  // Only look at recent messages to avoid redundant extraction
  const maxMessages = options.maxMessages ?? MAX_RECENT_MESSAGES;
  const recent = messages.slice(-maxMessages);
  const formatted = recent
    .map((m) => {
      if (m.role === "user") {
        const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        return `User: ${content}`;
      }
      if (m.role === "assistant") {
        const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        return `Assistant: ${content}`;
      }
      return null;
    })
    .filter(Boolean)
    .join("\n");

  if (!formatted.trim()) return [];

  try {
    const { text } = await generateText({
      model,
      system: buildExtractionPrompt(options.topic),
      prompt: formatted,
    });

    // Parse JSON array from response (handle markdown code blocks and surrounding prose)
    const cleaned = text.replace(/```json?\n?/g, "").replace(/```/g, "").trim();

    // Try to find a JSON array in the response — the model sometimes wraps it in prose
    const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
    if (!arrayMatch) {
      // No array found — model returned plain text, nothing to extract
      return [];
    }

    const parsed = JSON.parse(arrayMatch[0]);

    if (!Array.isArray(parsed)) {
      logger.warn("Fact extraction returned non-array");
      return [];
    }

    return parsed.filter((f): f is string => typeof f === "string" && f.trim().length > 0);
  } catch (err) {
    logger.warn(`Fact extraction failed: ${err instanceof Error ? err.message : err}`);
    return [];
  }
}
