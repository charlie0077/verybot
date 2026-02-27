import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (payload: unknown) => unknown>();
  const commandHandlers = new Map<string, (payload: unknown) => unknown>();
  const sendChatAction = vi.fn(async () => undefined);
  const sendMessage = vi.fn(async () => undefined);
  const sendVoice = vi.fn(async () => undefined);
  const setMyCommands = vi.fn(async () => undefined);
  const start = vi.fn();
  const stop = vi.fn(async () => undefined);
  const transcribe = vi.fn(async () => "voice text");

  class BotMock {
    api = {
      sendChatAction,
      sendMessage,
      sendVoice,
      setMyCommands,
    };
    command = vi.fn((name: string, handler: (payload: unknown) => unknown) => {
      commandHandlers.set(name, handler);
    });
    on = vi.fn((name: string, handler: (payload: unknown) => unknown) => {
      handlers.set(name, handler);
    });
    start = start;
    stop = stop;
  }

  return {
    handlers,
    commandHandlers,
    sendChatAction,
    sendMessage,
    sendVoice,
    setMyCommands,
    start,
    stop,
    transcribe,
    BotMock,
  };
});

vi.mock("grammy", () => ({
  Bot: mocks.BotMock,
  InputFile: class {},
}));

vi.mock("../../tts/transcribe.js", () => ({
  transcribe: mocks.transcribe,
}));

import { createTelegramChannel } from "./channel.js";

describe("createTelegramChannel typing lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.handlers.clear();
    mocks.commandHandlers.clear();
    mocks.sendChatAction.mockClear().mockResolvedValue(undefined);
    mocks.sendMessage.mockClear().mockResolvedValue(undefined);
    mocks.sendVoice.mockClear().mockResolvedValue(undefined);
    mocks.setMyCommands.mockClear().mockResolvedValue(undefined);
    mocks.start.mockClear();
    mocks.stop.mockClear();
    mocks.transcribe.mockClear().mockResolvedValue("voice text");
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("stops typing after text message handling even with no outbound reply", async () => {
    const onMessage = vi.fn(async () => undefined);
    const channel = createTelegramChannel({
      token: "token",
      onMessage,
    });

    await channel.start();

    const textHandler = mocks.handlers.get("message:text");
    expect(textHandler).toBeDefined();

    await textHandler?.({
      chat: { id: 42 },
      from: { id: 7 },
      message: {
        text: "hello",
        entities: [],
      },
    });

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(mocks.sendChatAction).toHaveBeenCalledWith(42, "typing");

    vi.advanceTimersByTime(5_000);
    expect(mocks.sendChatAction).toHaveBeenCalledTimes(1);

    await channel.stop();
  });

  it("keeps typing active until voice onMessage resolves, then stops", async () => {
    let release = () => {};
    let notifyCalled = () => {};
    const called = new Promise<void>((resolve) => {
      notifyCalled = resolve;
    });
    const onMessage = vi.fn(() => {
      notifyCalled();
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const channel = createTelegramChannel({
      token: "token",
      onMessage,
    });

    await channel.start();

    const voiceHandler = mocks.handlers.get("message:voice");
    expect(voiceHandler).toBeDefined();

    const run = voiceHandler?.({
      chat: { id: 99 },
      from: { id: 8 },
      getFile: async () => ({ file_path: "voice.ogg" }),
      reply: vi.fn(async () => undefined),
    });

    await called;

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(mocks.sendChatAction).toHaveBeenCalledWith(99, "typing");

    vi.advanceTimersByTime(4_500);
    expect(mocks.sendChatAction.mock.calls.length).toBeGreaterThanOrEqual(2);

    release();
    await run;

    const callCountAfterResolve = mocks.sendChatAction.mock.calls.length;
    vi.advanceTimersByTime(4_500);
    expect(mocks.sendChatAction).toHaveBeenCalledTimes(callCountAfterResolve);

    await channel.stop();
  });
});
