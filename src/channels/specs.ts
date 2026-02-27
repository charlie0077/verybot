import type { MessageHandler } from "./types.js";
import type { ChannelSpec } from "./manager.js";
import { channelFingerprint } from "./manager.js";
import { createTelegramChannel } from "./telegram/channel.js";
import { createDiscordChannel } from "./discord/channel.js";
import { createSlackChannel, type SlackSchedulerOpts } from "./slack/channel.js";
import { createWhatsAppChannel } from "./whatsapp/channel.js";
import { resolveMarkdownTableMode } from "../markdown/tables.js";
import type { MarkdownTableMode } from "../markdown/ir.js";
import type { ConnectedChannelRegistry } from "../scheduler/connected-channels.js";
import type { Config } from "../config.js";

export interface ChannelCallbacks {
  onMessage: MessageHandler;
  onClear: (channelType: string, channelId: string, teamId?: string) => Promise<void>;
  onLearn: (
    channelType: string,
    channelId: string,
    topic?: string,
    teamId?: string,
  ) => Promise<{
    topic?: string;
    extracted: number;
    saved: number;
    skipped: number;
    savedFacts: string[];
  }>;
  onRemember: (
    channelType: string,
    channelId: string,
    fact: string,
    teamId?: string,
  ) => Promise<{ saved: boolean; fact: string }>;
  listTeams: () => { id: string; name: string }[];
  connectedChannels: ConnectedChannelRegistry | null;
  /** Return the raw per-channel table config value (resolved lazily at send time). */
  getChannelTableConfig: (channel: string) => MarkdownTableMode | string | null | undefined;
}

/** Build scheduler opts shared across channels. */
function buildSchedulerOpts(
  channelType: string,
  connectedChannels: ConnectedChannelRegistry,
): SlackSchedulerOpts {
  return {
    connectScheduler: (teamId: string, channelId: string, sendFn: (text: string) => Promise<void>) =>
      connectedChannels.connect(teamId, {
        channelType,
        channelId,
        send: sendFn,
      }),
    disconnectScheduler: (teamId: string, key: string) => connectedChannels.disconnect(teamId, key),
  };
}

/**
 * Build channel specs from config. Pure function — all side effects are
 * deferred via callbacks so agent.ts stays thin.
 */
export function buildChannelSpecs(config: Config, cb: ChannelCallbacks): ChannelSpec[] {
  const specs: ChannelSpec[] = [];

  if (config.channels.telegram) {
    const token = config.channels.telegram.token;
    const resolveTableMode = () =>
      resolveMarkdownTableMode({ channel: "telegram", channelTableMode: cb.getChannelTableConfig("telegram") });
    specs.push({
      name: "telegram",
      fingerprint: channelFingerprint(token),
      create: () =>
        createTelegramChannel({
          token,
          listTeams: cb.listTeams,
          onMessage: cb.onMessage,
          onClear: cb.onClear,
          onLearn: cb.onLearn,
          onRemember: cb.onRemember,
          resolveTableMode,
        }),
    });
  }

  if (config.channels.discord) {
    const token = config.channels.discord.token;
    const resolveTableMode = () =>
      resolveMarkdownTableMode({ channel: "discord", channelTableMode: cb.getChannelTableConfig("discord") });
    specs.push({
      name: "discord",
      fingerprint: channelFingerprint(token),
      create: () =>
        createDiscordChannel({
          token,
          listTeams: cb.listTeams,
          onMessage: cb.onMessage,
          onClear: cb.onClear,
          onLearn: cb.onLearn,
          onRemember: cb.onRemember,
          resolveTableMode,
        }),
    });
  }

  if (config.channels.slack) {
    const { botToken, appToken } = config.channels.slack;
    const resolveTableMode = () =>
      resolveMarkdownTableMode({ channel: "slack", channelTableMode: cb.getChannelTableConfig("slack") });
    const schedulerOpts: SlackSchedulerOpts | undefined = cb.connectedChannels
      ? buildSchedulerOpts("slack", cb.connectedChannels)
      : undefined;
    specs.push({
      name: "slack",
      fingerprint: channelFingerprint(botToken + appToken),
      create: () =>
        createSlackChannel({
          botToken,
          appToken,
          listTeams: cb.listTeams,
          onMessage: cb.onMessage,
          onClear: cb.onClear,
          onLearn: cb.onLearn,
          onRemember: cb.onRemember,
          schedulerOpts,
          resolveTableMode,
        }),
    });
  }

  if (config.channels.whatsapp) {
    const { phoneId } = config.channels.whatsapp;
    const resolveTableMode = () =>
      resolveMarkdownTableMode({ channel: "whatsapp", channelTableMode: cb.getChannelTableConfig("whatsapp") });
    specs.push({
      name: "whatsapp",
      fingerprint: channelFingerprint(phoneId),
      create: () =>
        createWhatsAppChannel({
          phoneId,
          selfOnly: config.channels.whatsapp?.selfOnly,
          listTeams: cb.listTeams,
          onMessage: cb.onMessage,
          onClear: cb.onClear,
          onLearn: cb.onLearn,
          onRemember: cb.onRemember,
          resolveTableMode,
        }),
    });
  }

  return specs;
}
