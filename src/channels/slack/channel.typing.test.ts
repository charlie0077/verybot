import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const eventHandlers = new Map<string, (payload: unknown) => unknown>();
  const reactionsAdd = vi.fn(async () => undefined);
  const reactionsRemove = vi.fn(async () => undefined);
  const postMessage = vi.fn(async () => undefined);
  const start = vi.fn(async () => undefined);
  const stop = vi.fn(async () => undefined);

  class AppMock {
    client = {
      reactions: {
        add: reactionsAdd,
        remove: reactionsRemove,
      },
      chat: {
        postMessage,
      },
      conversations: {
        replies: vi.fn(async () => ({ messages: [] })),
        history: vi.fn(async () => ({ messages: [] })),
      },
    };

    event = vi.fn((name: string, handler: (payload: unknown) => unknown) => {
      eventHandlers.set(name, handler);
    });

    start = start;
    stop = stop;
  }

  return {
    eventHandlers,
    reactionsAdd,
    reactionsRemove,
    postMessage,
    start,
    stop,
    AppMock,
  };
});

vi.mock("@slack/bolt", () => ({
  App: mocks.AppMock,
}));

import { createSlackChannel } from "./channel.js";

describe("createSlackChannel typing lifecycle", () => {
  beforeEach(() => {
    mocks.eventHandlers.clear();
    mocks.reactionsAdd.mockClear().mockResolvedValue(undefined);
    mocks.reactionsRemove.mockClear().mockResolvedValue(undefined);
    mocks.postMessage.mockClear().mockResolvedValue(undefined);
    mocks.start.mockClear().mockResolvedValue(undefined);
    mocks.stop.mockClear().mockResolvedValue(undefined);
  });

  it("removes typing reaction after mention handling even with no outbound reply", async () => {
    const onMessage = vi.fn(async () => undefined);
    const channel = createSlackChannel({
      botToken: "bot-token",
      appToken: "app-token",
      onMessage,
    });

    await channel.start();

    const mentionHandler = mocks.eventHandlers.get("app_mention");
    expect(mentionHandler).toBeDefined();

    await mentionHandler?.({
      event: {
        channel: "C123",
        user: "U456",
        text: "<@BOT123> hello",
        ts: "1710000000.000100",
      },
      context: {
        botUserId: "BOT123",
      },
    });

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(mocks.reactionsAdd).toHaveBeenCalledWith({
      channel: "C123",
      timestamp: "1710000000.000100",
      name: "eyes",
    });
    expect(mocks.reactionsRemove).toHaveBeenCalledWith({
      channel: "C123",
      timestamp: "1710000000.000100",
      name: "eyes",
    });

    await channel.stop();
  });

  it("removes typing reactions for overlapping mentions in the same channel", async () => {
    const releases: Array<() => void> = [];
    let notifyCalled = () => {};
    const calledTwice = new Promise<void>((resolve) => {
      let count = 0;
      notifyCalled = () => {
        count += 1;
        if (count === 2) resolve();
      };
    });
    const onMessage = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          notifyCalled();
          releases.push(resolve);
        }),
    );
    const channel = createSlackChannel({
      botToken: "bot-token",
      appToken: "app-token",
      onMessage,
    });

    await channel.start();

    const mentionHandler = mocks.eventHandlers.get("app_mention");
    expect(mentionHandler).toBeDefined();

    const first = mentionHandler?.({
      event: {
        channel: "C123",
        user: "U111",
        text: "<@BOT123> first",
        ts: "1710000000.000100",
      },
      context: {
        botUserId: "BOT123",
      },
    });

    const second = mentionHandler?.({
      event: {
        channel: "C123",
        user: "U222",
        text: "<@BOT123> second",
        ts: "1710000000.000200",
      },
      context: {
        botUserId: "BOT123",
      },
    });

    await calledTwice;
    expect(onMessage).toHaveBeenCalledTimes(2);

    releases[0]?.();
    releases[1]?.();
    await Promise.all([first, second]);

    expect(mocks.reactionsRemove).toHaveBeenCalledWith({
      channel: "C123",
      timestamp: "1710000000.000100",
      name: "eyes",
    });
    expect(mocks.reactionsRemove).toHaveBeenCalledWith({
      channel: "C123",
      timestamp: "1710000000.000200",
      name: "eyes",
    });

    await channel.stop();
  });

  it("ignores DM messages that become empty after mention stripping", async () => {
    const onMessage = vi.fn(async () => undefined);
    const channel = createSlackChannel({
      botToken: "bot-token",
      appToken: "app-token",
      onMessage,
    });

    await channel.start();

    const dmHandler = mocks.eventHandlers.get("message");
    expect(dmHandler).toBeDefined();

    await dmHandler?.({
      event: {
        channel_type: "im",
        channel: "D123",
        user: "U456",
        text: "<@BOT123>   ",
        ts: "1710000000.001000",
      },
      context: {
        botUserId: "BOT123",
      },
    });

    expect(onMessage).not.toHaveBeenCalled();
    expect(mocks.reactionsAdd).not.toHaveBeenCalled();
    expect(mocks.reactionsRemove).not.toHaveBeenCalled();

    await channel.stop();
  });
});
