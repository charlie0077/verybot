import { EventEmitter } from "node:events";

/** App-wide event bus. Business logic emits here; transport layers subscribe. */
const bus = new EventEmitter();
bus.setMaxListeners(50);

export function emit(event: string, payload: unknown): void {
  bus.emit(event, payload);
}

export function on(event: string, handler: (payload: unknown) => void): () => void {
  bus.on(event, handler);
  return () => { bus.off(event, handler); };
}
