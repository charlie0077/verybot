import { tool, type Tool, type ToolSet } from "ai";
import { z } from "zod";
import { synthesize } from "../tts/edge.js";
import { playAudio, pauseAudio, resumeAudio, stopAudio } from "../tts/speak.js";
import { logger } from "../logger.js";

export interface TTSConfig {
  enabled: boolean;
  voice: string;
}

const PREVIEW_LENGTH = 80;

/**
 * Create TTS tools: speak (synthesize + play) and speech_control (pause/resume/stop).
 * Returns null when TTS is disabled.
 */
export function createSpeakTools(config: TTSConfig): ToolSet | null {
  if (!config.enabled) return null;

  const speak = tool({
    description:
      "Speak text aloud through the computer's speakers. " +
      "Keep spoken text concise and conversational. " +
      "Do NOT speak code blocks, URLs, or long technical output — use text for those.",
    inputSchema: z.object({
      text: z.string().describe("The text to speak aloud"),
      voice: z
        .string()
        .optional()
        .describe("Edge TTS voice name (e.g. en-US-GuyNeural). Defaults to config voice."),
    }),
    execute: async ({ text, voice }) => {
      try {
        // voice param overrides; otherwise auto-detect from text content
        const audioPath = await synthesize(text, voice);
        playAudio(audioPath);

        const preview = text.length > PREVIEW_LENGTH
          ? `${text.slice(0, PREVIEW_LENGTH)}...`
          : text;
        return `Spoke: "${preview}"`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`TTS failed: ${msg}`);
        return `TTS error: ${msg}`;
      }
    },
  });

  const speechControl = tool({
    description:
      "Control ongoing speech playback. Use this to pause, resume, or stop the current TTS audio.",
    inputSchema: z.object({
      action: z.enum(["pause", "resume", "stop"]).describe("The playback control action"),
    }),
    execute: async ({ action }) => {
      switch (action) {
        case "pause": return pauseAudio();
        case "resume": return resumeAudio();
        case "stop": return stopAudio();
      }
    },
  });

  return { speak, speech_control: speechControl };
}
