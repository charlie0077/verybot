import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (payload: unknown) => unknown>();
  const sendTyping = vi.fn(async () => undefined);
  const send = vi.fn(async () => undefined);
  const login = vi.fn(async () => "ok");
  const destroy = vi.fn(async () => undefined);
  const channelMap = new Map<string, unknown>();

  class ClientMock {
    user = { id: "bot-user", tag: "Bot#0001" };
    channels = {
      cache: channelMap,
    };

    constructor() {
      channelMap.set("chan-1", {
        isTextBased: () => true,
        sendTyping,
        send,
      });
    }

    on = vi.fn((event: string, handler: (payload: unknown) => unknown) => {
      handlers.set(event, handler);
    });

    login = login;
    destroy = destroy;
  }

  return {
    handlers,
    sendTyping,
    send,
    login,
    destroy,
    channelMap,
    ClientMock,
  };
});

vi.mock("discord.js", () => ({
  Client: mocks.ClientMock,
  GatewayIntentBits: {
    Guilds: 1,
    GuildMessages: 2,
    MessageContent: 4,
    DirectMessages: 8,
  },
  Partials: {
    Channel: "Channel",
  },
  Events: {
    MessageCreate: "messageCreate",
  },
}));

import { createDiscordChannel } from "./channel.js";

describe("createDiscordChannel typing lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.handlers.clear();
    mocks.sendTyping.mockClear().mockResolvedValue(undefined);
    mocks.send.mockClear().mockResolvedValue(undefined);
    mocks.login.mockClear().mockResolvedValue("ok");
    mocks.destroy.mockClear().mockResolvedValue(undefined);
    mocks.channelMap.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops typing after mention handling even with no outbound reply", async () => {
    const onMessage = vi.fn(async () => undefined);
    const channel = createDiscordChannel({
      token: "token",
      onMessage,
    });

    await channel.start();

    const handler = mocks.handlers.get("messageCreate");
    expect(handler).toBeDefined();

    await handler?.({
      author: { id: "user-1", bot: false },
      guild: { id: "guild-1" },
      mentions: { has: () => true },
      channelId: "chan-1",
      content: "hello bot",
    });

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(mocks.sendTyping).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(9_000);
    expect(mocks.sendTyping).toHaveBeenCalledTimes(1);

    await channel.stop();
  });
});
