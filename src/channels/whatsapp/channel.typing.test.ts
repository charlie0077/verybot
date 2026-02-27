import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (payload: unknown) => unknown>();
  const sendPresenceUpdate = vi.fn(async (_state: string, _jid: string) => undefined);
  const sendMessage = vi.fn(
    async (_jid: string, _content: unknown, _options?: { messageId?: string }) => ({ key: { id: "sent-1" } }),
  );
  let generatedIdCounter = 0;
  const generateMessageIDV2 = vi.fn(() => {
    generatedIdCounter += 1;
    return `generated-${generatedIdCounter}`;
  });
  const end = vi.fn();
  const saveCreds = vi.fn();
  const on = vi.fn((event: string, handler: (payload: unknown) => unknown) => {
    handlers.set(event, handler);
  });
  const socket = {
    sendPresenceUpdate,
    sendMessage,
    end,
    ev: { on },
  };

  const makeWASocket = vi.fn(() => socket);
  const useMultiFileAuthState = vi.fn(async () => ({ state: {}, saveCreds }));
  const downloadMediaMessage = vi.fn();
  const emit = vi.fn();

  return {
    handlers,
    sendPresenceUpdate,
    sendMessage,
    generateMessageIDV2,
    end,
    saveCreds,
    makeWASocket,
    useMultiFileAuthState,
    downloadMediaMessage,
    emit,
  };
});

vi.mock("@whiskeysockets/baileys", () => ({
  default: mocks.makeWASocket,
  useMultiFileAuthState: mocks.useMultiFileAuthState,
  DisconnectReason: { loggedOut: 401 },
  downloadMediaMessage: mocks.downloadMediaMessage,
  generateMessageIDV2: mocks.generateMessageIDV2,
}));

vi.mock("qrcode", () => ({
  default: { toDataURL: vi.fn(async () => "data:image/png;base64,qr") },
}));

vi.mock("../../events.js", () => ({ emit: mocks.emit }));

import { createWhatsAppChannel } from "./channel.js";

describe("createWhatsAppChannel typing lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.handlers.clear();
    mocks.sendPresenceUpdate.mockClear().mockResolvedValue(undefined);
    mocks.sendMessage.mockClear().mockResolvedValue({ key: { id: "sent-1" } });
    mocks.generateMessageIDV2.mockClear();
    mocks.end.mockClear();
    mocks.saveCreds.mockClear();
    mocks.makeWASocket.mockClear();
    mocks.useMultiFileAuthState.mockClear();
    mocks.downloadMediaMessage.mockClear();
    mocks.emit.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops typing even when onMessage does not send a reply", async () => {
    const onMessage = vi.fn(async () => {});
    const channel = createWhatsAppChannel({
      phoneId: "test-phone",
      onMessage,
    });

    await channel.start();

    const upsertHandler = mocks.handlers.get("messages.upsert");
    expect(upsertHandler).toBeDefined();

    await upsertHandler?.({
      type: "notify",
      messages: [
        {
          key: { remoteJid: "123@s.whatsapp.net", id: "msg-1", fromMe: false },
          message: { conversation: "hello" },
        },
      ],
    });

    expect(onMessage).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(6_000);

    const jid = "123@s.whatsapp.net";
    const presenceCalls = mocks.sendPresenceUpdate.mock.calls.filter(
      (call) => call[1] === jid,
    );
    expect(presenceCalls).toEqual([
      ["composing", jid],
      ["paused", jid],
    ]);

    await channel.stop();
  });

  it("does not reconnect after stop when a reconnect backoff is pending", async () => {
    const channel = createWhatsAppChannel({
      phoneId: "test-phone",
      onMessage: vi.fn(async () => {}),
    });

    await channel.start();
    expect(mocks.makeWASocket).toHaveBeenCalledTimes(1);

    const connectionHandler = mocks.handlers.get("connection.update");
    expect(connectionHandler).toBeDefined();

    await connectionHandler?.({
      connection: "close",
      lastDisconnect: {
        error: {
          output: {
            statusCode: 500,
          },
        },
      },
    });

    await channel.stop();
    vi.advanceTimersByTime(65_000);
    expect(mocks.makeWASocket).toHaveBeenCalledTimes(1);
  });

  it("processes self-authored fromMe messages when self-only mode is disabled", async () => {
    const onMessage = vi.fn(async () => {});
    const channel = createWhatsAppChannel({
      phoneId: "test-phone",
      onMessage,
    });

    await channel.start();

    const upsertHandler = mocks.handlers.get("messages.upsert");
    expect(upsertHandler).toBeDefined();

    await upsertHandler?.({
      type: "notify",
      messages: [
        {
          key: { remoteJid: "123@s.whatsapp.net", id: "self-msg-1", fromMe: true },
          message: { conversation: "hello from me" },
        },
      ],
    });

    expect(onMessage).toHaveBeenCalledTimes(1);
    await channel.stop();
  });

  it("in self-only mode, handles self-authored input but ignores tracked bot replies", async () => {
    const onMessage = vi.fn(async () => {});
    const channel = createWhatsAppChannel({
      phoneId: "test-phone",
      selfOnly: true,
      onMessage,
    });

    await channel.start();
    await channel.send("123@s.whatsapp.net", "bot reply");

    const upsertHandler = mocks.handlers.get("messages.upsert");
    expect(upsertHandler).toBeDefined();

    await upsertHandler?.({
      type: "notify",
      messages: [
        {
          key: { remoteJid: "123@s.whatsapp.net", id: "sent-1", fromMe: true },
          message: { conversation: "bot reply" },
        },
      ],
    });
    expect(onMessage).not.toHaveBeenCalled();

    await upsertHandler?.({
      type: "notify",
      messages: [
        {
          key: { remoteJid: "123@s.whatsapp.net", id: "self-msg-1", fromMe: true },
          message: { conversation: "hello from me" },
        },
      ],
    });
    expect(onMessage).toHaveBeenCalledTimes(1);

    await channel.stop();
  });

  it("ignores bot echo in self-only mode even when upsert arrives before send resolves", async () => {
    const onMessage = vi.fn(async () => {});
    const channel = createWhatsAppChannel({
      phoneId: "test-phone",
      selfOnly: true,
      onMessage,
    });

    await channel.start();
    const upsertHandler = mocks.handlers.get("messages.upsert");
    expect(upsertHandler).toBeDefined();

    let outboundMessageId: string | undefined;
    let resolveSend: ((value: { key: { id: string } }) => void) | undefined;
    mocks.sendMessage.mockImplementationOnce(async (_jid, _content, options?: { messageId?: string }) => {
      outboundMessageId = options?.messageId;
      return await new Promise<{ key: { id: string } }>((resolve) => {
        resolveSend = resolve;
      });
    });

    const sendPromise = channel.send("123@s.whatsapp.net", "bot reply");
    expect(outboundMessageId).toBeDefined();

    await upsertHandler?.({
      type: "notify",
      messages: [
        {
          key: { remoteJid: "123@s.whatsapp.net", id: outboundMessageId, fromMe: true },
          message: { conversation: "bot reply" },
        },
      ],
    });

    expect(onMessage).not.toHaveBeenCalled();

    resolveSend?.({ key: { id: outboundMessageId! } });
    await sendPromise;
    await channel.stop();
  });
});
