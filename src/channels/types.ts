export interface IncomingMessage {
  channelType: string;
  channelId: string;
  userId: string;
  text?: string;
  /** Whether this message originated from a voice input. */
  isVoice?: boolean;
  /** Team ID resolved by the channel (e.g. via /team command in Telegram). */
  teamId?: string;
}

export type MessageHandler = (
  msg: IncomingMessage,
  channel: Channel
) => Promise<void>;

export interface ChannelMessage {
  user: string;
  text: string;
  ts: string;
}

export interface Channel {
  name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(channelId: string, text: string): Promise<void>;
  /** Send a voice message. Falls back to text if not supported by the channel. */
  sendVoice?(channelId: string, audioPath: string): Promise<void>;
  /** Read recent messages from a channel/thread. */
  readHistory?(channelId: string, limit?: number, threadTs?: string): Promise<ChannelMessage[]>;
}
