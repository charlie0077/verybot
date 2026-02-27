import OpenAI from "openai";
import { logger } from "../logger.js";

const TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe";

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI();
  }
  return client;
}

/**
 * Transcribe an audio buffer to text using OpenAI's gpt-4o-mini-transcribe.
 * Accepts ogg/opus (Telegram voice), mp3, wav, m4a, webm, etc.
 */
export async function transcribe(
  audioBuffer: Buffer,
  filename: string = "voice.ogg",
): Promise<string> {
  // Telegram sends .oga (Opus in Ogg) — normalize to .ogg which OpenAI accepts
  const normalizedName = filename.replace(/\.oga$/, ".ogg");
  const file = new File([new Uint8Array(audioBuffer)], normalizedName, {
    type: mimeFromFilename(normalizedName),
  });

  const result = await getClient().audio.transcriptions.create({
    model: TRANSCRIBE_MODEL,
    file,
  });

  logger.info(`Transcribed ${audioBuffer.length} bytes → ${result.text.length} chars`);
  return result.text;
}

function mimeFromFilename(name: string): string {
  if (name.endsWith(".ogg") || name.endsWith(".oga")) return "audio/ogg";
  if (name.endsWith(".mp3")) return "audio/mpeg";
  if (name.endsWith(".wav")) return "audio/wav";
  if (name.endsWith(".m4a")) return "audio/mp4";
  if (name.endsWith(".webm")) return "audio/webm";
  return "audio/ogg";
}
