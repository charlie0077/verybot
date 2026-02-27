import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import type { Agent } from "../../brain/agent.js";
import type { ConfigStore } from "../../config/store.js";
import { logger } from "../../logger.js";
import { WHATSAPP_AUTH_DIR } from "../../paths.js";

export function whatsappMethods(
  getAgent: () => Agent,
  configStore: ConfigStore,
) {
  return {
    /**
     * Generate an opaque phoneId, save it to config, and trigger channel start.
     * The WhatsApp channel will emit QR code events via the event bus.
     */
    "whatsapp.link": async () => {
      const phoneId = randomUUID();
      configStore.patch({ WHATSAPP_PHONE_ID: phoneId });
      logger.info(`[whatsapp] link requested, phoneId=${phoneId}`);
      await getAgent().forceConfigReload();
      return { phoneId };
    },

    /** Clear the phoneId from config, stop the channel, and wipe auth state. */
    "whatsapp.unlink": async () => {
      configStore.patch({ WHATSAPP_PHONE_ID: "" });
      logger.info("[whatsapp] unlink requested");
      await getAgent().forceConfigReload();
      // Remove Baileys auth state so next link starts a fresh QR session
      await rm(WHATSAPP_AUTH_DIR, { recursive: true, force: true });
      return { status: "unlinked" };
    },

    /** Return whether WhatsApp is configured (has a non-empty phoneId). */
    "whatsapp.status": async () => {
      const data = configStore.load();
      const phoneId = data.WHATSAPP_PHONE_ID;
      const linked = typeof phoneId === "string" && phoneId !== "";
      return { linked };
    },
  };
}
