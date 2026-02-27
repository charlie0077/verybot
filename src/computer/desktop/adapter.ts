export interface ScreenInfo {
  /** Screenshot pixel width (retina resolution). */
  widthPx: number;
  /** Screenshot pixel height (retina resolution). */
  heightPx: number;
  /** Retina scale factor (1 for non-retina, 2 for retina). */
  scaleFactor: number;
}

export interface DesktopAdapter {
  getScreenInfo(): ScreenInfo;
  screenshot(): Promise<Buffer>;
  click(x: number, y: number): Promise<void>;
  doubleClick(x: number, y: number): Promise<void>;
  rightClick(x: number, y: number): Promise<void>;
  middleClick(x: number, y: number): Promise<void>;
  tripleClick(x: number, y: number): Promise<void>;
  mouseMove(x: number, y: number): Promise<void>;
  type(text: string): Promise<void>;
  /** Press a key or key combination (xdotool syntax, e.g. "Return", "ctrl+s"). */
  key(combo: string): Promise<void>;
  scroll(
    x: number,
    y: number,
    direction: "up" | "down" | "left" | "right",
    amount: number,
  ): Promise<void>;
  getCursorPosition(): Promise<[number, number]>;
  dragTo(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
  ): Promise<void>;
}

export async function createDesktopAdapter(): Promise<DesktopAdapter> {
  switch (process.platform) {
    case "darwin": {
      const { MacOSAdapter } = await import("./macos.js");
      return new MacOSAdapter();
    }
    default:
      throw new Error(
        `Desktop control is not yet supported on ${process.platform}. ` +
          `Currently supported: macOS (darwin).`,
      );
  }
}
