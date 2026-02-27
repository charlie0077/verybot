import { EdgeTTS } from "node-edge-tts";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { logger } from "../logger.js";

const OUTPUT_FORMAT = "audio-24khz-96kbitrate-mono-mp3";
const MAX_TEXT_LENGTH = 2_000;
const SYNTHESIS_TIMEOUT = 300_000;

/** Default voices per detected language. */
const VOICE_MAP: Record<string, string> = {
  zh: "zh-CN-XiaoxiaoNeural",
  ja: "ja-JP-NanamiNeural",
  ko: "ko-KR-SunHiNeural",
  en: "en-US-AriaNeural",
};
const FALLBACK_VOICE = "en-US-AriaNeural";

// CJK Unicode ranges for language detection
const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/;
const JAPANESE_RE = /[\u3040-\u309f\u30a0-\u30ff]/;
const KOREAN_RE = /[\uac00-\ud7af\u1100-\u11ff]/;

/** Detect dominant language from text content. */
export function detectLanguage(text: string): string {
  // Sample first 200 chars for speed
  const sample = text.slice(0, 200);
  if (JAPANESE_RE.test(sample)) return "ja";
  if (KOREAN_RE.test(sample)) return "ko";
  if (CJK_RE.test(sample)) return "zh";
  return "en";
}

/** Pick the right voice for the text language. */
export function resolveVoice(text: string, explicitVoice?: string): string {
  if (explicitVoice) return explicitVoice;
  const lang = detectLanguage(text);
  return VOICE_MAP[lang] ?? FALLBACK_VOICE;
}

/**
 * Synthesize text to an mp3 file using Microsoft Edge TTS.
 * Free, no API key required — uses the same neural voices as Edge browser.
 * Returns the path to the generated mp3 file (caller must clean up).
 */
export async function synthesize(
  text: string,
  voice?: string,
): Promise<string> {
  const trimmed = text.length > MAX_TEXT_LENGTH
    ? text.slice(0, MAX_TEXT_LENGTH)
    : text;

  const resolvedVoice = resolveVoice(trimmed, voice);
  const outPath = join(tmpdir(), `edge-tts-${randomBytes(6).toString("hex")}.mp3`);
  const tts = new EdgeTTS({
    voice: resolvedVoice,
    lang: resolvedVoice.split("-").slice(0, 2).join("-"),
    outputFormat: OUTPUT_FORMAT,
    timeout: SYNTHESIS_TIMEOUT,
  });
  await tts.ttsPromise(trimmed, outPath);

  logger.info(`TTS synthesized ${trimmed.length} chars with voice=${resolvedVoice}`);
  return outPath;
}
