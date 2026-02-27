// TODO: phase 7 — memory types

export interface MemoryEntry {
  id: string;
  fact: string;
  source: string; // session key that produced this fact
  timestamp: number;
  embedding?: number[];
  /** Team scope — undefined/null = global memory visible to all teams. */
  teamId?: string;
}
