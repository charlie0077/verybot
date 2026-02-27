export type UserImageContentPart = {
  type: "image";
  image: string;
  mediaType?: string;
};

export type UserTextContentPart = {
  type: "text";
  text: string;
};

export type UserMessageContent = string | Array<UserImageContentPart | UserTextContentPart>;

export function mergeImageDataUrls(first?: string[], second?: string[]): string[] | undefined {
  if (!first?.length && !second?.length) return undefined;

  const merged: string[] = [];
  const seen = new Set<string>();
  for (const url of [...(first ?? []), ...(second ?? [])]) {
    if (seen.has(url)) continue;
    seen.add(url);
    merged.push(url);
  }

  return merged.length > 0 ? merged : undefined;
}

/**
 * Build AI SDK user message content with image parts when data URLs are available.
 * Keeps text-only content as a plain string for the common path.
 */
export function buildUserMessageContent(text: string, imageDataUrls?: string[]): UserMessageContent {
  if (!imageDataUrls?.length) return text;

  return [
    ...imageDataUrls.map((dataUrl) => {
      // Parse data URL (data:image/png;base64,AAAA...) into raw base64 + mediaType
      const match = dataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/s);
      if (match) {
        return { type: "image" as const, image: match[2], mediaType: match[1] };
      }
      return { type: "image" as const, image: dataUrl };
    }),
    { type: "text" as const, text },
  ];
}
