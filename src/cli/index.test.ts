import { describe, expect, it } from "vitest";
import { parseRuntimeCliOptions } from "./index.js";

const LOCAL_HOST = "127.0.0.1";
const LAN_PORT = 10_000;
const API_PORT = 28_789;
const INVALID_PORT = "70000";

describe("parseRuntimeCliOptions", () => {
  it("returns empty options with no args", () => {
    expect(parseRuntimeCliOptions([])).toEqual({});
  });

  it("ignores runtime parsing for handled subcommands", () => {
    expect(parseRuntimeCliOptions(["config", "get"])).toEqual({});
    expect(parseRuntimeCliOptions(["--version"])).toEqual({});
    expect(parseRuntimeCliOptions(["help"])).toEqual({});
  });

  it("parses split --host and --port flags", () => {
    expect(parseRuntimeCliOptions(["--host", LOCAL_HOST, "--port", String(LAN_PORT)])).toEqual({
      gatewayHost: LOCAL_HOST,
      gatewayPort: LAN_PORT,
    });
  });

  it("parses inline --host and --port flags", () => {
    expect(parseRuntimeCliOptions([`--host=${LOCAL_HOST}`, `--port=${API_PORT}`])).toEqual({
      gatewayHost: LOCAL_HOST,
      gatewayPort: API_PORT,
    });
  });

  it("uses the last host flag when multiple are present", () => {
    expect(parseRuntimeCliOptions(["--host", "0.0.0.0", "--host", LOCAL_HOST])).toEqual({ gatewayHost: LOCAL_HOST });
  });

  it("throws when --host has no value", () => {
    expect(() => parseRuntimeCliOptions(["--host"])).toThrow("Missing value for --host");
  });

  it("throws when --port is out of range", () => {
    expect(() => parseRuntimeCliOptions(["--port", INVALID_PORT])).toThrow("Invalid --port value");
  });
});
