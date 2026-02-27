import { handleConfigCommand } from "./config.js";
import { handleClaudeLogin } from "./claude-login.js";
import { getVersion } from "../version.js";

const VERSION_FLAGS = new Set(["--version", "-v"]);
const HELP_FLAGS = new Set(["--help", "-h", "help"]);
const HANDLED_SUBCOMMANDS = new Set(["config", "claude-login"]);

const HOST_FLAG = "--host";
const PORT_FLAG = "--port";
const HOST_FLAG_PREFIX = `${HOST_FLAG}=`;
const PORT_FLAG_PREFIX = `${PORT_FLAG}=`;

const PORT_MIN = 1;
const PORT_MAX = 65_535;

export interface RuntimeCliOptions {
  gatewayHost?: string;
  gatewayPort?: number;
}

function printHelp(): void {
  console.log(`Usage:
  verybot
  verybot --host <host> [--port <port>]
  verybot config get [key]
  verybot config set <key> <value>
  verybot config regenerate_gateway_token
  verybot claude-login
`);
}

function parsePort(raw: string): number {
  const port = Number(raw);
  const isValid = Number.isInteger(port) && port >= PORT_MIN && port <= PORT_MAX;
  if (!isValid) {
    throw new Error(`Invalid --port value "${raw}". Expected an integer between ${PORT_MIN} and ${PORT_MAX}.`);
  }
  return port;
}

function parseHost(raw: string): string {
  const host = raw.trim();
  if (!host) throw new Error("Missing value for --host");
  return host;
}

function requireFlagValue(argv: string[], idx: number, flag: string): string {
  const value = argv[idx + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

/** Parse runtime flags used when launching the main gateway process. */
export function parseRuntimeCliOptions(argv: string[] = process.argv.slice(2)): RuntimeCliOptions {
  const first = argv[0];
  if (!first) return {};
  if (VERSION_FLAGS.has(first) || HELP_FLAGS.has(first) || HANDLED_SUBCOMMANDS.has(first)) return {};

  const options: RuntimeCliOptions = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === HOST_FLAG) {
      options.gatewayHost = parseHost(requireFlagValue(argv, i, HOST_FLAG));
      i += 1;
      continue;
    }

    if (arg.startsWith(HOST_FLAG_PREFIX)) {
      options.gatewayHost = parseHost(arg.slice(HOST_FLAG_PREFIX.length));
      continue;
    }

    if (arg === PORT_FLAG) {
      options.gatewayPort = parsePort(requireFlagValue(argv, i, PORT_FLAG));
      i += 1;
      continue;
    }

    if (arg.startsWith(PORT_FLAG_PREFIX)) {
      options.gatewayPort = parsePort(arg.slice(PORT_FLAG_PREFIX.length));
    }
  }

  return options;
}

/**
 * Route lightweight CLI subcommands without booting the gateway.
 * Returns a promise (or null) so the caller can await async commands.
 */
export function handleCli(): Promise<void> | null {
  const [cmd, sub, ...rest] = process.argv.slice(2);

  if (cmd && VERSION_FLAGS.has(cmd)) {
    console.log(`verybot v${getVersion()}`);
    return Promise.resolve();
  }

  if (cmd && HELP_FLAGS.has(cmd)) {
    printHelp();
    return Promise.resolve();
  }

  if (cmd === "config") {
    handleConfigCommand(sub, rest);
    return Promise.resolve();
  }

  if (cmd === "claude-login") {
    return handleClaudeLogin();
  }

  return null;
}
