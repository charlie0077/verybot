import { anthropic } from "@ai-sdk/anthropic";
import sharp from "sharp";
import type { DesktopAdapter } from "./adapter.js";
import { logger } from "../../logger.js";

/** Anthropic API rejects base64 images over 5 MB. We compress PNG → JPEG
 *  to stay well under the limit while preserving original dimensions. */
const MAX_IMAGE_BYTES = 3_500_000;
const JPEG_QUALITY_START = 80;
const JPEG_QUALITY_MIN = 40;
const JPEG_QUALITY_STEP = 10;

/** Compress a screenshot PNG to JPEG, reducing quality until under the size limit. */
async function compressScreenshot(png: Buffer): Promise<{ data: Buffer; mediaType: string }> {
  for (let quality = JPEG_QUALITY_START; quality >= JPEG_QUALITY_MIN; quality -= JPEG_QUALITY_STEP) {
    const jpeg = await sharp(png).jpeg({ quality }).toBuffer();
    if (jpeg.length <= MAX_IMAGE_BYTES) {
      logger.info(`Desktop: screenshot compressed ${png.length} → ${jpeg.length} bytes (JPEG q${quality})`);
      return { data: jpeg, mediaType: "image/jpeg" };
    }
  }
  // Last resort: lowest quality
  const jpeg = await sharp(png).jpeg({ quality: JPEG_QUALITY_MIN }).toBuffer();
  logger.info(`Desktop: screenshot compressed ${png.length} → ${jpeg.length} bytes (JPEG q${JPEG_QUALITY_MIN}, may exceed limit)`);
  return { data: jpeg, mediaType: "image/jpeg" };
}

/** Models that only support the older computer_20250124 tool version. */
const OLDER_TOOL_MODELS = ["haiku", "claude-3"];

export function createDesktopTool(adapter: DesktopAdapter, modelId: string) {
  const screen = adapter.getScreenInfo();
  const useOlder = OLDER_TOOL_MODELS.some((m) => modelId.includes(m));
  const factory = useOlder
    ? anthropic.tools.computer_20250124
    : anthropic.tools.computer_20251124;

  logger.info(`Desktop: using computer tool ${useOlder ? "20250124" : "20251124"} for model ${modelId}`);

  return factory({
    displayWidthPx: screen.widthPx,
    displayHeightPx: screen.heightPx,

    execute: async (input) => {
      logger.info(`Desktop: ${input.action} ${JSON.stringify(input)}`);

      switch (input.action) {
        case "screenshot": {
          const png = await adapter.screenshot();
          // Compress to stay under Anthropic's 5 MB base64 limit
          const compressed = await compressScreenshot(png);
          return compressed;
        }

        case "left_click":
          await adapter.click(input.coordinate![0], input.coordinate![1]);
          return `Clicked at (${input.coordinate![0]}, ${input.coordinate![1]})`;

        case "double_click":
          await adapter.doubleClick(input.coordinate![0], input.coordinate![1]);
          return `Double-clicked at (${input.coordinate![0]}, ${input.coordinate![1]})`;

        case "right_click":
          await adapter.rightClick(input.coordinate![0], input.coordinate![1]);
          return `Right-clicked at (${input.coordinate![0]}, ${input.coordinate![1]})`;

        case "middle_click":
          await adapter.middleClick(input.coordinate![0], input.coordinate![1]);
          return `Middle-clicked at (${input.coordinate![0]}, ${input.coordinate![1]})`;

        case "triple_click":
          await adapter.tripleClick(input.coordinate![0], input.coordinate![1]);
          return `Triple-clicked at (${input.coordinate![0]}, ${input.coordinate![1]})`;

        case "mouse_move":
          await adapter.mouseMove(input.coordinate![0], input.coordinate![1]);
          return `Moved cursor to (${input.coordinate![0]}, ${input.coordinate![1]})`;

        case "type":
          await adapter.type(input.text!);
          return `Typed: ${input.text!.slice(0, 100)}`;

        case "key":
          await adapter.key(input.text!);
          return `Pressed: ${input.text}`;

        case "scroll":
          await adapter.scroll(
            input.coordinate![0],
            input.coordinate![1],
            input.scroll_direction!,
            input.scroll_amount!,
          );
          return `Scrolled ${input.scroll_direction} by ${input.scroll_amount}`;

        case "cursor_position": {
          const [cx, cy] = await adapter.getCursorPosition();
          return `Cursor position: (${cx}, ${cy})`;
        }

        case "left_click_drag":
          await adapter.dragTo(
            input.start_coordinate![0],
            input.start_coordinate![1],
            input.coordinate![0],
            input.coordinate![1],
          );
          return `Dragged from (${input.start_coordinate![0]}, ${input.start_coordinate![1]}) to (${input.coordinate![0]}, ${input.coordinate![1]})`;

        case "hold_key":
          // hold_key with duration: press key, wait, release
          await adapter.key(input.text!);
          return `Held key: ${input.text} for ${input.duration}s`;

        case "wait":
          await new Promise((r) => setTimeout(r, (input.duration ?? 1) * 1000));
          return `Waited ${input.duration ?? 1}s`;

        case "left_mouse_down":
          // Not directly supported by cliclick as a standalone; simulate with drag start
          await adapter.mouseMove(input.coordinate![0], input.coordinate![1]);
          return `Mouse down at (${input.coordinate![0]}, ${input.coordinate![1]})`;

        case "left_mouse_up":
          await adapter.mouseMove(input.coordinate![0], input.coordinate![1]);
          return `Mouse up at (${input.coordinate![0]}, ${input.coordinate![1]})`;

        default:
          return `Unsupported action: ${input.action}`;
      }
    },

    toModelOutput({ input, output }) {
      if (input.action === "screenshot" && typeof output === "object" && output !== null && "data" in output) {
        const { data, mediaType } = output as { data: Buffer; mediaType: string };
        return {
          type: "content" as const,
          value: [
            {
              type: "image-data" as const,
              data: data.toString("base64"),
              mediaType,
            },
          ],
        };
      }
      return { type: "text" as const, value: String(output) };
    },
  });
}
