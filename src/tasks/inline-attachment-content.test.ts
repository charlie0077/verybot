import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { resolveInlineAttachmentContent } from "./inline-attachment-content.js";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));

describe("resolveInlineAttachmentContent", () => {
  beforeEach(() => {
    vi.mocked(readFile).mockReset();
  });

  it("returns input unchanged when no inline attachment markdown exists", async () => {
    const input = "Task: summarize the notes";
    const result = await resolveInlineAttachmentContent(input);

    expect(result).toEqual({
      normalizedText: input,
      imageDataUrls: [],
    });
    expect(readFile).not.toHaveBeenCalled();
  });

  it("replaces inline attachment markdown and resolves images as data URLs", async () => {
    vi.mocked(readFile).mockResolvedValueOnce(Buffer.from("abc"));

    const result = await resolveInlineAttachmentContent(
      "Description: ![image](attachment://photo.png)",
    );

    expect(result.normalizedText).toBe("Description: [image attached]");
    expect(result.imageDataUrls).toEqual(["data:image/png;base64,YWJj"]);
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it("deduplicates attachment IDs before reading files", async () => {
    vi.mocked(readFile).mockResolvedValueOnce(Buffer.from("abc"));

    const result = await resolveInlineAttachmentContent(
      [
        "![first](attachment://same.png)",
        "middle",
        "![second](attachment://same.png)",
      ].join("\n"),
    );

    expect(result.imageDataUrls).toEqual(["data:image/png;base64,YWJj"]);
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it("ignores invalid attachment IDs while still cleaning markdown", async () => {
    const result = await resolveInlineAttachmentContent(
      "Description: ![image](attachment://../secret.png)",
    );

    expect(result.normalizedText).toBe("Description: [image attached]");
    expect(result.imageDataUrls).toEqual([]);
    expect(readFile).not.toHaveBeenCalled();
  });
});
