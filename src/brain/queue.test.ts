import { describe, expect, it } from "vitest";
import { MessageQueue } from "./queue.js";

const SHORT_DELAY_MS = 0;
const SIMULATED_RUN_MS = 200;

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, SHORT_DELAY_MS));
}

function createAbortError(): Error {
  return new DOMException("Aborted", "AbortError");
}

describe("MessageQueue abort", () => {
  it("resolves in-flight message with empty reply when aborted", async () => {
    const queue = new MessageQueue({
      mode: "collect",
      processMessage: async (_sessionKey, _text, signal) => {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, SIMULATED_RUN_MS);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(createAbortError());
            },
            { once: true },
          );
        });
        return "done";
      },
    });

    const replyPromise = queue.enqueue("session-1", "hello");
    await tick();

    expect(queue.abort("session-1")).toBe(true);
    await expect(replyPromise).resolves.toBe("");
  });

  it("also resolves queued messages when aborting a busy lane", async () => {
    const queue = new MessageQueue({
      mode: "collect",
      processMessage: async (_sessionKey, _text, signal) => {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, SIMULATED_RUN_MS);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(createAbortError());
            },
            { once: true },
          );
        });
        return "done";
      },
    });

    const first = queue.enqueue("session-2", "first");
    await tick();
    const second = queue.enqueue("session-2", "second");

    expect(queue.abort("session-2")).toBe(true);
    await expect(Promise.all([first, second])).resolves.toEqual(["", ""]);
  });

  it("returns false when there is no active or queued run", () => {
    const queue = new MessageQueue({
      mode: "collect",
      processMessage: async () => "done",
    });

    expect(queue.abort("missing-session")).toBe(false);
  });
});

