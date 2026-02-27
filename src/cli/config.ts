import { ConfigStore } from "../config/store.js";
import { seedConfigStore, generateGatewayToken } from "../config.js";
import { BASE_DIR } from "../paths.js";

/** Resolve a dot-separated path on a nested object. */
function getByPath(obj: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>(
    (o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined),
    obj,
  );
}

/** Build a nested partial object from a dot-separated path and a value. */
function setByPath(path: string, value: unknown): Record<string, unknown> {
  const keys = path.split(".");
  if (keys.length === 1) return { [path]: value };
  const root: Record<string, unknown> = {};
  let current = root;
  for (let i = 0; i < keys.length - 1; i++) {
    current[keys[i]] = {};
    current = current[keys[i]] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]] = value;
  return root;
}

/** Auto-coerce CLI string values to native types. */
function coerce(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  const num = Number(raw);
  if (!Number.isNaN(num) && raw.trim() !== "") return num;
  return raw;
}

/**
 * Handle `config get [KEY]` and `config set KEY VALUE` CLI subcommands.
 * Operates directly on config.json — no gateway boot needed.
 */
export function handleConfigCommand(sub: string | undefined, rest: string[]): void {
  const store = new ConfigStore(BASE_DIR);
  seedConfigStore(store);

  if (sub === "get") {
    const key = rest[0];
    if (!key) {
      console.log(JSON.stringify(store.getRedacted(), null, 2));
      return;
    }
    const data = store.load();
    const value = getByPath(data, key);
    if (value === undefined) {
      console.error(`Key "${key}" not found in config`);
      process.exitCode = 1;
      return;
    }
    console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
    return;
  }

  if (sub === "set") {
    const [key, ...valueParts] = rest;
    if (!key || valueParts.length === 0) {
      console.error("Usage: config set KEY VALUE");
      process.exitCode = 1;
      return;
    }
    const value = coerce(valueParts.join(" "));
    store.patch(setByPath(key, value));
    console.log(`Set ${key}`);
    return;
  }

  if (sub === "regenerate_gateway_token") {
    const token = generateGatewayToken();
    store.patch({ GATEWAY_TOKEN: token });
    console.log(token);
    return;
  }

  console.error("Usage: config get [KEY] | config set KEY VALUE | config regenerate_gateway_token");
  process.exitCode = 1;
}
