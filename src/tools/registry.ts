import type { Tool, ToolSet } from "ai";

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(name: string, tool: Tool) {
    this.tools.set(name, tool);
  }

  getAll(): ToolSet {
    return Object.fromEntries(this.tools);
  }
}
