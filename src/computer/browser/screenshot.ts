import sharp from "sharp";
import { logger } from "../../logger.js";

/** Anthropic API rejects base64 images over 5 MB. Compress PNG -> JPEG to stay under. */
const MAX_IMAGE_BYTES = 3_500_000;
const JPEG_QUALITY_START = 80;
const JPEG_QUALITY_MIN = 40;
const JPEG_QUALITY_STEP = 10;

/** Compress a screenshot PNG to JPEG, reducing quality until under the size limit. */
export async function compressScreenshot(
  png: Buffer,
): Promise<{ base64: string; mediaType: string }> {
  let lastJpeg: Buffer | null = null;
  for (
    let quality = JPEG_QUALITY_START;
    quality >= JPEG_QUALITY_MIN;
    quality -= JPEG_QUALITY_STEP
  ) {
    lastJpeg = await sharp(png).jpeg({ quality }).toBuffer();
    if (lastJpeg.length <= MAX_IMAGE_BYTES) {
      logger.info(
        `Browser: screenshot compressed ${png.length} -> ${lastJpeg.length} bytes (JPEG q${quality})`,
      );
      return { base64: lastJpeg.toString("base64"), mediaType: "image/jpeg" };
    }
  }
  // Last resort: use the already-computed lowest quality buffer
  logger.info(
    `Browser: screenshot compressed ${png.length} -> ${lastJpeg!.length} bytes (JPEG q${JPEG_QUALITY_MIN}, may exceed limit)`,
  );
  return { base64: lastJpeg!.toString("base64"), mediaType: "image/jpeg" };
}
