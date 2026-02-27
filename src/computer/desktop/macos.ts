import { execFileSync, execSync } from "child_process";
import { readFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import type { DesktopAdapter, ScreenInfo } from "./adapter.js";
import { logger } from "../../logger.js";

/** Timeout for shell commands (ms). */
const CMD_TIMEOUT = 30_000;

/** xdotool key name → cliclick key name */
const KEY_MAP: Record<string, string> = {
  return: "return",
  enter: "return",
  tab: "tab",
  space: "space",
  escape: "escape",
  delete: "delete",
  backspace: "delete",
  up: "arrow-up",
  down: "arrow-down",
  left: "arrow-left",
  right: "arrow-right",
  home: "home",
  end: "end",
  pageup: "page-up",
  page_up: "page-up",
  pagedown: "page-down",
  page_down: "page-down",
  f1: "f1",
  f2: "f2",
  f3: "f3",
  f4: "f4",
  f5: "f5",
  f6: "f6",
  f7: "f7",
  f8: "f8",
  f9: "f9",
  f10: "f10",
  f11: "f11",
  f12: "f12",
};

/** xdotool modifier → cliclick modifier */
const MODIFIER_MAP: Record<string, string> = {
  ctrl: "ctrl",
  control: "ctrl",
  alt: "alt",
  option: "alt",
  shift: "shift",
  super: "cmd",
  meta: "cmd",
  cmd: "cmd",
  command: "cmd",
};

export class MacOSAdapter implements DesktopAdapter {
  private screenInfo: ScreenInfo | null = null;

  constructor() {
    this.checkDependencies();
  }

  getScreenInfo(): ScreenInfo {
    if (!this.screenInfo) {
      this.screenInfo = this.detectScreenInfo();
    }
    return this.screenInfo;
  }

  async screenshot(): Promise<Buffer> {
    const tmpFile = join(tmpdir(), `mvp-screenshot-${randomUUID()}.png`);
    try {
      execFileSync("screencapture", ["-x", "-t", "png", tmpFile], {
        timeout: CMD_TIMEOUT,
      });
      return readFileSync(tmpFile);
    } finally {
      try {
        unlinkSync(tmpFile);
      } catch {
        // ignore cleanup errors
      }
    }
  }

  async click(x: number, y: number): Promise<void> {
    const [lx, ly] = this.toLogical(x, y);
    this.cliclick(`c:${lx},${ly}`);
  }

  async doubleClick(x: number, y: number): Promise<void> {
    const [lx, ly] = this.toLogical(x, y);
    this.cliclick(`dc:${lx},${ly}`);
  }

  async rightClick(x: number, y: number): Promise<void> {
    const [lx, ly] = this.toLogical(x, y);
    this.cliclick(`rc:${lx},${ly}`);
  }

  async middleClick(x: number, y: number): Promise<void> {
    // cliclick doesn't have a native middle-click; simulate with option+click
    const [lx, ly] = this.toLogical(x, y);
    this.cliclick(`kd:alt`, `c:${lx},${ly}`, `ku:alt`);
  }

  async tripleClick(x: number, y: number): Promise<void> {
    const [lx, ly] = this.toLogical(x, y);
    this.cliclick(`tc:${lx},${ly}`);
  }

  async mouseMove(x: number, y: number): Promise<void> {
    const [lx, ly] = this.toLogical(x, y);
    this.cliclick(`m:${lx},${ly}`);
  }

  async type(text: string): Promise<void> {
    // cliclick t: types the literal text
    this.cliclick(`t:${text}`);
  }

  async key(combo: string): Promise<void> {
    const parts = combo.split("+").map((s) => s.trim().toLowerCase());
    const modifiers: string[] = [];
    let mainKey: string | null = null;

    for (const part of parts) {
      if (MODIFIER_MAP[part]) {
        modifiers.push(MODIFIER_MAP[part]);
      } else {
        mainKey = KEY_MAP[part] ?? part;
      }
    }

    if (!mainKey && modifiers.length > 0) {
      // Single modifier key press (e.g., just "shift")
      mainKey = modifiers.pop()!;
    }

    if (!mainKey) {
      logger.warn(`Desktop: could not parse key combo "${combo}"`);
      return;
    }

    const args: string[] = [];
    for (const mod of modifiers) args.push(`kd:${mod}`);
    args.push(`kp:${mainKey}`);
    for (const mod of modifiers.reverse()) args.push(`ku:${mod}`);

    this.cliclick(...args);
  }

  async scroll(
    x: number,
    y: number,
    direction: "up" | "down" | "left" | "right",
    amount: number,
  ): Promise<void> {
    const [lx, ly] = this.toLogical(x, y);
    // Move to position first, then use AppleScript for scrolling
    this.cliclick(`m:${lx},${ly}`);

    // AppleScript scroll: positive = up, negative = down
    const scrollAmount = direction === "up" || direction === "left" ? amount : -amount;
    const axis = direction === "left" || direction === "right" ? "axis 1" : "axis 2";

    // Use CGEvent for scrolling via python3 (available on macOS)
    const script =
      `tell application "System Events" to ` +
      `scroll ${axis === "axis 2" ? "vertically" : "horizontally"} by ${scrollAmount}`;
    try {
      execFileSync("osascript", ["-e", script], { timeout: CMD_TIMEOUT });
    } catch {
      // Fallback: use key-based scrolling
      const key = direction === "up" ? "arrow-up" : "arrow-down";
      for (let i = 0; i < Math.abs(amount); i++) {
        this.cliclick(`kp:${key}`);
      }
    }
  }

  async getCursorPosition(): Promise<[number, number]> {
    const output = execFileSync("cliclick", ["p:"], {
      encoding: "utf-8",
      timeout: CMD_TIMEOUT,
    }).trim();
    // Output format: "x,y" (logical coordinates)
    const [lx, ly] = output.split(",").map(Number);
    const { scaleFactor } = this.getScreenInfo();
    return [lx * scaleFactor, ly * scaleFactor];
  }

  async dragTo(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
  ): Promise<void> {
    const [sx, sy] = this.toLogical(startX, startY);
    const [ex, ey] = this.toLogical(endX, endY);
    this.cliclick(`dd:${sx},${sy}`, `du:${ex},${ey}`);
  }

  // ── Private helpers ──

  private checkDependencies(): void {
    try {
      execFileSync("which", ["cliclick"], { timeout: CMD_TIMEOUT });
    } catch {
      throw new Error(
        "cliclick is required for desktop control on macOS. " +
          "Install it with: brew install cliclick",
      );
    }
  }

  private detectScreenInfo(): ScreenInfo {
    // Get screenshot pixel dimensions
    const tmpFile = join(tmpdir(), `mvp-screeninfo-${randomUUID()}.png`);
    try {
      execFileSync("screencapture", ["-x", "-t", "png", tmpFile], {
        timeout: CMD_TIMEOUT,
      });
      const sipsOutput = execFileSync(
        "sips",
        ["-g", "pixelWidth", "-g", "pixelHeight", tmpFile],
        { encoding: "utf-8", timeout: CMD_TIMEOUT },
      );

      const widthMatch = sipsOutput.match(/pixelWidth:\s*(\d+)/);
      const heightMatch = sipsOutput.match(/pixelHeight:\s*(\d+)/);
      const widthPx = widthMatch ? Number(widthMatch[1]) : 1920;
      const heightPx = heightMatch ? Number(heightMatch[1]) : 1080;

      // Get logical screen size via osascript
      const logicalOutput = execSync(
        `osascript -l JavaScript -e 'ObjC.import("AppKit"); ` +
          `var f = $.NSScreen.mainScreen.frame; ` +
          `f.size.width + " " + f.size.height'`,
        { encoding: "utf-8", timeout: CMD_TIMEOUT },
      ).trim();
      const [logicalW] = logicalOutput.split(" ").map(Number);
      const scaleFactor = logicalW > 0 ? Math.round(widthPx / logicalW) : 2;

      logger.info(
        `Desktop: screen ${widthPx}x${heightPx}px, logical ${logicalOutput}, scale ${scaleFactor}x`,
      );

      return { widthPx, heightPx, scaleFactor };
    } finally {
      try {
        unlinkSync(tmpFile);
      } catch {
        // ignore
      }
    }
  }

  /** Convert pixel coordinates to logical (point) coordinates for cliclick. */
  private toLogical(x: number, y: number): [number, number] {
    const { scaleFactor } = this.getScreenInfo();
    return [Math.round(x / scaleFactor), Math.round(y / scaleFactor)];
  }

  /** Run cliclick with the given action arguments. */
  private cliclick(...args: string[]): void {
    execFileSync("cliclick", args, { timeout: CMD_TIMEOUT });
  }
}
