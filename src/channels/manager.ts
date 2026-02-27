import { createHash } from "crypto";
import type { Channel } from "./types.js";
import { logger } from "../logger.js";

export interface ChannelSpec {
  name: string;
  /** Opaque fingerprint (e.g. hash of token). Change triggers stop→start cycle. */
  fingerprint: string;
  /** Factory that creates a fresh Channel instance. */
  create: () => Channel;
}

/** Hash a token to produce a safe fingerprint (never store/log raw secrets). */
export function channelFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

/** Settle delay between stopping an old channel and starting the replacement.
 *  Telegram's getUpdates long-poll needs ~2s to release server-side. */
const SETTLE_MS = 2_000;

export class ChannelManager {
  private channels: Channel[] = [];
  private byName = new Map<string, Channel>();
  private fingerprints = new Map<string, string>();
  private reconciling = false;

  register(channel: Channel, fingerprint?: string) {
    this.channels.push(channel);
    this.byName.set(channel.name, channel);
    if (fingerprint) this.fingerprints.set(channel.name, fingerprint);
  }

  /** Look up a channel by name (e.g. "telegram"). */
  get(name: string): Channel | undefined {
    return this.byName.get(name);
  }

  async startAll() {
    for (const ch of this.channels) {
      try {
        await ch.start();
        logger.info(`Channel started: ${ch.name}`);
      } catch (err) {
        logger.error(`Failed to start channel ${ch.name}: ${err}`);
      }
    }
  }

  async stopAll() {
    await Promise.all(this.channels.map((c) => c.stop()));
  }

  /** Stop and unregister a single channel by name. */
  private async stopOne(name: string): Promise<boolean> {
    const ch = this.byName.get(name);
    if (!ch) return false;

    try {
      await ch.stop();
      logger.info(`Channel stopped: ${name}`);
    } catch (err) {
      logger.error(`Failed to stop channel ${name}: ${err}`);
    }

    this.byName.delete(name);
    this.fingerprints.delete(name);
    this.channels = this.channels.filter((c) => c.name !== name);
    return true;
  }

  /**
   * Diff current channels against desired specs. Stop removed/changed channels,
   * start new/changed ones. Self-guarding: concurrent calls are skipped
   * (the next reloadConfig cycle will catch the mismatch).
   */
  async reconcile(specs: ChannelSpec[]): Promise<void> {
    if (this.reconciling) {
      logger.info("Channel reconcile already in progress, skipping");
      return;
    }
    this.reconciling = true;

    try {
      const desired = new Map(specs.map((s) => [s.name, s]));

      // Stop channels that are no longer in config
      for (const name of [...this.byName.keys()]) {
        if (!desired.has(name)) {
          await this.stopOne(name);
        }
      }

      // Add or replace channels whose fingerprint changed
      for (const [name, spec] of desired) {
        if (this.fingerprints.get(name) === spec.fingerprint) continue;

        const hadExisting = await this.stopOne(name);

        // Settle delay so server-side connections release (e.g. Telegram long-poll)
        if (hadExisting) {
          await new Promise((r) => setTimeout(r, SETTLE_MS));
        }

        try {
          const channel = spec.create();
          await channel.start();
          this.register(channel, spec.fingerprint);
          logger.info(`Channel hot-reloaded: ${name}`);
        } catch (err) {
          // Don't register — next reconcile will retry since no fingerprint is stored
          logger.error(`Failed to start channel ${name} during reconcile: ${err}`);
        }
      }
    } finally {
      this.reconciling = false;
    }
  }
}
