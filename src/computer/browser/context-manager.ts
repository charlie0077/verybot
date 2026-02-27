/**
 * Browser Context Manager - manages browser instances across multiple sessions.
 */

import type { BrowserManager } from "./manager.js";
import type { BrowserConfig } from "./manager.js";
import { BrowserManager as BM } from "./manager.js";
import { logger } from "../../logger.js";

/**
 * Global registry of browser managers per session.
 */
const SESSION_MANAGERS: Map<string, BrowserManager> = new Map();

/**
 * Get or create a BrowserManager for the given session.
 */
export function getBrowserManager(
  sessionId: string,
  config?: BrowserConfig,
): BrowserManager {
  if (SESSION_MANAGERS.has(sessionId)) {
    return SESSION_MANAGERS.get(sessionId)!;
  }

  const finalConfig = config || {};
  const manager = new BM(finalConfig);
  manager.setSessionKey(sessionId);

  SESSION_MANAGERS.set(sessionId, manager);
  logger.info(`Created BrowserManager for session: ${sessionId}`);
  return manager;
}

/**
 * Release a session's browser manager and clean up resources.
 */
export async function releaseBrowserManager(sessionId: string): Promise<void> {
  const manager = SESSION_MANAGERS.get(sessionId);
  if (!manager) return;

  logger.info(`Releasing BrowserManager for session: ${sessionId}`);

  const pages = manager.getSessionPages(sessionId);
  for (const page of pages) {
    try {
      await page.close();
    } catch (err) {
      logger.warn(`Failed to close page for session ${sessionId}: ${err}`);
    }
  }

  SESSION_MANAGERS.delete(sessionId);
}

/**
 * Close all browser managers and clean up resources.
 */
export async function closeAllBrowsers(): Promise<void> {
  const managers = Array.from(SESSION_MANAGERS.values());
  const seenContexts = new Set();

  for (const manager of managers) {
    const contextId = (manager as any)['context']?.toString();
    if (contextId && !seenContexts.has(contextId)) {
      try {
        await manager.close();
        seenContexts.add(contextId);
      } catch (err) {
        logger.warn(`Failed to close browser: ${err}`);
      }
    }
  }

  SESSION_MANAGERS.clear();
  logger.info("All browsers closed");
}

/**
 * Get all active sessions.
 */
export function getActiveSessions(): string[] {
  return Array.from(SESSION_MANAGERS.keys());
}

/**
 * Get browser statistics.
 */
export function getBrowserStats(): {
  totalSessions: number;
  activeSessions: string[];
} {
  return {
    totalSessions: SESSION_MANAGERS.size,
    activeSessions: getActiveSessions(),
  };
}
