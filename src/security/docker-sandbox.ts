/**
 * Docker sandbox for bash tool execution.
 *
 * Commands run inside isolated Docker containers with:
 * - Read-only root filesystem
 * - No network access
 * - All capabilities dropped
 * - Resource limits (memory, pids)
 * - Workspace mounted at /workspace (read-write)
 *
 * Containers are created lazily per session and reused for subsequent commands.
 * Idle containers are pruned after a configurable timeout.
 *
 * If Docker is not available at startup, the sandbox polls in the background
 * and returns an error to the user until Docker comes online.
 */

import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { mkdirSync } from "fs";
import { resolve } from "path";
import { logger } from "../logger.js";
import { SANDBOX_WORKSPACE } from "../paths.js";

const CONTAINER_PREFIX = "verybot-sandbox";
const LABEL = "verybot-sandbox=1";
const EXEC_TIMEOUT = 30_000;
const MAX_OUTPUT = 10_000;
const MAX_ERROR = 5_000;
export interface SandboxConfig {
  image: string;
  memoryLimit: string;
  pidsLimit: number;
  idleTimeoutMs: number;
}

interface ContainerHandle {
  id: string;
  name: string;
  timer: ReturnType<typeof setTimeout>;
}

/** Check if Docker is available by running `docker info`. */
function checkDocker(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

export class DockerSandbox {
  private containers = new Map<string, ContainerHandle>();
  private config: SandboxConfig;
  private ready = false;

  constructor(config: SandboxConfig) {
    this.config = config;
    mkdirSync(resolve(SANDBOX_WORKSPACE), { recursive: true });
    logger.info(
      `Docker sandbox: configured (image=${config.image}, memory=${config.memoryLimit}, ` +
        `pids=${config.pidsLimit}, workspace=${SANDBOX_WORKSPACE}, idle=${config.idleTimeoutMs}ms)`,
    );
  }

  /**
   * Execute a command in the sandbox container for the given session.
   * Checks Docker availability on first use (and after losing connection).
   */
  exec(sessionKey: string, command: string): string {
    if (!this.ready) {
      if (!checkDocker()) {
        return "Docker is not available. Please start Docker and try again.";
      }
      this.ready = true;
      this.pruneOrphans();
      logger.info("Docker sandbox: Docker is available, ready to execute");
    }

    const handle = this.getOrCreateContainer(sessionKey);
    this.resetIdleTimer(sessionKey, handle);

    try {
      const output = execFileSync(
        "docker",
        ["exec", handle.id, "sh", "-c", command],
        {
          encoding: "utf-8",
          timeout: EXEC_TIMEOUT,
          maxBuffer: 1024 * 1024,
        },
      );
      return output.slice(0, MAX_OUTPUT);
    } catch (err: unknown) {
      // If docker exec itself failed (not the command inside), reset ready flag
      // so next call re-checks Docker availability
      if (this.isDockerError(err)) {
        logger.warn("Docker sandbox: Docker connection lost, will re-check on next exec");
        this.ready = false;
        this.containers.delete(sessionKey);
      }
      const msg = err instanceof Error ? err.message : String(err);
      const stderr = (err as { stderr?: string }).stderr ?? "";
      return `Error: ${msg}\n${stderr}`.slice(0, MAX_ERROR);
    }
  }

  /** Remove container for a session. */
  cleanup(sessionKey: string): void {
    const handle = this.containers.get(sessionKey);
    if (!handle) return;

    clearTimeout(handle.timer);
    this.removeContainer(handle);
    this.containers.delete(sessionKey);
  }

  /** Remove all containers (call on shutdown). */
  cleanupAll(): void {
    for (const [key, handle] of this.containers) {
      clearTimeout(handle.timer);
      this.removeContainer(handle);
      this.containers.delete(key);
    }
    logger.info("Docker sandbox: all containers cleaned up");
  }

  private getOrCreateContainer(sessionKey: string): ContainerHandle {
    const existing = this.containers.get(sessionKey);
    if (existing) return existing;

    const name = this.containerName(sessionKey);
    const workspaceAbs = resolve(SANDBOX_WORKSPACE);

    // Create container
    const createArgs = [
      "create",
      "--name",
      name,
      "--label",
      LABEL,
      "--read-only",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=64m",
      "--network",
      "none",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--memory",
      this.config.memoryLimit,
      "--pids-limit",
      String(this.config.pidsLimit),
      "-v",
      `${workspaceAbs}:/workspace:rw`,
      "-w",
      "/workspace",
      this.config.image,
      "sleep",
      "infinity",
    ];

    const id = execFileSync("docker", createArgs, {
      encoding: "utf-8",
      timeout: 30_000,
    }).trim();

    // Start container
    execFileSync("docker", ["start", id], {
      stdio: "ignore",
      timeout: 10_000,
    });

    logger.info(`Docker sandbox: created container ${name} (${id.slice(0, 12)}) for ${sessionKey}`);

    const handle: ContainerHandle = {
      id,
      name,
      timer: setTimeout(() => this.onIdle(sessionKey), this.config.idleTimeoutMs),
    };
    handle.timer.unref();

    this.containers.set(sessionKey, handle);
    return handle;
  }

  private resetIdleTimer(sessionKey: string, handle: ContainerHandle): void {
    clearTimeout(handle.timer);
    handle.timer = setTimeout(() => this.onIdle(sessionKey), this.config.idleTimeoutMs);
    handle.timer.unref();
  }

  private onIdle(sessionKey: string): void {
    const handle = this.containers.get(sessionKey);
    if (!handle) return;

    logger.info(`Docker sandbox: pruning idle container ${handle.name} for ${sessionKey}`);
    this.removeContainer(handle);
    this.containers.delete(sessionKey);
  }

  private removeContainer(handle: ContainerHandle): void {
    try {
      execFileSync("docker", ["rm", "-f", handle.id], {
        stdio: "ignore",
        timeout: 10_000,
      });
    } catch (err) {
      logger.warn(`Docker sandbox: failed to remove ${handle.name}: ${err instanceof Error ? err.message : err}`);
    }
  }

  private containerName(sessionKey: string): string {
    const hash = createHash("sha256").update(sessionKey).digest("hex").slice(0, 12);
    return `${CONTAINER_PREFIX}-${hash}`;
  }

  /**
   * Distinguish Docker daemon errors (connection lost, daemon stopped) from
   * normal command failures inside the container (non-zero exit code).
   */
  private isDockerError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    const stderr = (err as { stderr?: string }).stderr ?? "";
    const combined = `${msg}\n${stderr}`.toLowerCase();

    // These indicate Docker itself is unavailable, not a command failure
    return (
      combined.includes("cannot connect to the docker daemon") ||
      combined.includes("connection refused") ||
      combined.includes("is the docker daemon running") ||
      combined.includes("no such container") ||
      combined.includes("is not running")
    );
  }

  private pruneOrphans(): void {
    try {
      const ids = execFileSync(
        "docker",
        ["ps", "-aq", "--filter", `label=${LABEL}`],
        { encoding: "utf-8", timeout: 5_000 },
      ).trim();

      if (!ids) return;

      const idList = ids.split("\n").filter(Boolean);
      for (const id of idList) {
        try {
          execFileSync("docker", ["rm", "-f", id], { stdio: "ignore", timeout: 5_000 });
        } catch {
          // ignore individual failures
        }
      }
      logger.info(`Docker sandbox: pruned ${idList.length} orphan container(s)`);
    } catch {
      // docker ps failed, ignore
    }
  }
}
