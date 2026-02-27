import { describe, expect, it } from "vitest";
import { buildUserMessageContent, mergeImageDataUrls } from "./user-content.js";

describe("user-content helpers", () => {
  it("deduplicates merged image data urls while preserving order", () => {
    const merged = mergeImageDataUrls(
      ["data:image/png;base64,AAA", "data:image/png;base64,BBB"],
      ["data:image/png;base64,BBB", "data:image/png;base64,CCC"],
    );

    expect(merged).toEqual([
      "data:image/png;base64,AAA",
      "data:image/png;base64,BBB",
      "data:image/png;base64,CCC",
    ]);
  });

  it("builds multipart user content when image data urls are present", () => {
    const content = buildUserMessageContent("Task [image attached]", ["data:image/png;base64,YWJj"]);

    expect(content).toEqual([
      { type: "image", image: "YWJj", mediaType: "image/png" },
      { type: "text", text: "Task [image attached]" },
    ]);
  });

  it("keeps plain text content when no image data urls exist", () => {
    const content = buildUserMessageContent("Task only", undefined);
    expect(content).toBe("Task only");
  });
});
