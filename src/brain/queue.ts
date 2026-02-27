export type QueueMode = "sequential" | "collect";

interface QueuedMessage {
  text: string;
  images?: string[];
  resolve: (reply: string) => void;
  reject: (err: unknown) => void;
}

interface SessionLane {
  queue: QueuedMessage[];
  running: boolean;
  abort: AbortController | null;
}

export class MessageQueue {
  private lanes = new Map<string, SessionLane>();
  private mode: QueueMode;
  private processMessage: (sessionKey: string, text: string, signal: AbortSignal, images?: string[]) => Promise<string>;

  constructor(opts: {
    mode?: QueueMode;
    processMessage: (sessionKey: string, text: string, signal: AbortSignal, images?: string[]) => Promise<string>;
  }) {
    this.mode = opts.mode ?? "collect";
    this.processMessage = opts.processMessage;
  }

  /** Enqueue a message. Returns a promise that resolves with the agent reply. */
  enqueue(sessionKey: string, text: string, images?: string[]): Promise<string> {
    const lane = this.getOrCreateLane(sessionKey);

    return new Promise<string>((resolve, reject) => {
      lane.queue.push({ text, images, resolve, reject });

      // If idle, start draining
      if (!lane.running) {
        this.drain(sessionKey);
      }
    });
  }

  /** Abort the current run for a session. */
  abort(sessionKey: string): boolean {
    const lane = this.lanes.get(sessionKey);
    if (!lane) return false;

    let aborted = false;
    if (lane.abort) {
      lane.abort.abort();
      aborted = true;
    }

    if (lane.queue.length > 0) {
      const pending = lane.queue.splice(0);
      for (const msg of pending) msg.resolve("");
      aborted = true;
    }

    return aborted;
  }

  /** Remove the lane for a cleared session. Aborts any in-flight run first. */
  deleteLane(sessionKey: string): void {
    const lane = this.lanes.get(sessionKey);
    if (lane?.abort) lane.abort.abort();
    this.lanes.delete(sessionKey);
  }

  private async drain(sessionKey: string) {
    const lane = this.lanes.get(sessionKey);
    if (!lane || lane.running) return;

    lane.running = true;

    while (lane.queue.length > 0) {
      const batch = lane.queue.splice(0);
      const controller = new AbortController();
      lane.abort = controller;

      try {
        if (this.mode === "collect") {
          const combined = batch.map((m) => m.text).join("\n");
          // Collect images from all messages in the batch
          const allImages = batch.flatMap((m) => m.images ?? []);
          const images = allImages.length > 0 ? allImages : undefined;
          const reply = await this.processMessage(sessionKey, combined, controller.signal, images);
          // Only the last message gets the reply; earlier ones resolve empty (no Telegram send)
          for (let i = 0; i < batch.length - 1; i++) batch[i].resolve("");
          batch[batch.length - 1].resolve(reply);
        } else {
          for (const msg of batch) {
            if (controller.signal.aborted) {
              msg.resolve("");
              continue;
            }
            const reply = await this.processMessage(sessionKey, msg.text, controller.signal, msg.images);
            msg.resolve(reply);
          }
        }
      } catch (err) {
        if (controller.signal.aborted || isAbortLikeError(err)) {
          for (const msg of batch) msg.resolve("");
        } else {
          for (const msg of batch) msg.reject(err);
        }
      }

      lane.abort = null;
      // Loop continues if new messages arrived during processing
    }

    lane.running = false;
    // Remove idle lane to prevent unbounded growth
    if (lane.queue.length === 0) this.lanes.delete(sessionKey);
  }

  private getOrCreateLane(sessionKey: string): SessionLane {
    let lane = this.lanes.get(sessionKey);
    if (!lane) {
      lane = { queue: [], running: false, abort: null };
      this.lanes.set(sessionKey, lane);
    }
    return lane;
  }
}

function isAbortLikeError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "AbortError") return true;
  const msg = err.message.toLowerCase();
  return msg.includes("aborted") || msg.includes("abort");
}
