import { $ } from "bun";
import pLimit from "p-limit";
import ora from "ora";
import chalk from "chalk";
import * as p from "@clack/prompts";
import { saveFailed } from "./component-state";
import { isInstalled } from "./utils";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const INSTALL_TIMEOUT_MS = 15_000;
const INSTALL_CONCURRENCY = 1;
const INSTALL_ATTEMPTS = 3;
type InstallQueueOptions = {
  concurrency?: number;
  overwrite?: boolean;
};

function formatComponentList(items: string[], prefix = "│  ", maxWidth = 96) {
  if (items.length === 0) return `${prefix}-`;

  const lines: string[] = [];
  let current = "";

  for (const item of items) {
    const token = current.length === 0 ? item : `, ${item}`;
    if ((prefix.length + current.length + token.length) <= maxWidth) {
      current += token;
      continue;
    }
    if (current.length > 0) lines.push(`${prefix}${current}`);
    current = item;
  }

  if (current.length > 0) lines.push(`${prefix}${current}`);
  return lines.join("\n");
}

function formatEta(ms: number) {
  if (ms < 1000) return "<1s";
  const s = Math.ceil(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

const ERROR_PATTERNS = [
  /^error:/i,
  /^✖/,
  /something went wrong/i,
  /unknown error/i,
  /ERR!/,
  /EEXIST/,
  /ENOENT/,
  /EPERM/,
  /EACCES/,
  /ETIMEDOUT/,
  /ECONNREFUSED/,
  /failed to/i,
  /could not/i,
  /not found/i,
  /missing/i,
  /cannot/i,
];

function extractError(err: unknown): string {
  const { stderr = "", stdout = "", message = "" } = toCommandError(err);
  const parts = [stderr.trim(), stdout.trim(), message.trim()].filter(Boolean);

  for (const raw of parts) {
    const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);

    const errorLine = lines.findLast((line) =>
      ERROR_PATTERNS.some((p) => p.test(line))
    );

    if (errorLine) return errorLine;

    const useful = lines.filter(
      (l) =>
        !l.startsWith("Bun v") &&
        !l.startsWith("Saved lockfile") &&
        !l.startsWith("Resolving dependencies") &&
        !l.startsWith("Resolved, downloaded and extracted") &&
        !l.startsWith("- Installing") &&
        !l.startsWith("- Checking registry") &&
        !l.startsWith("✔ Checking registry") &&
        !l.startsWith("✔ Installing dependencies") &&
        !l.startsWith("- Updating files") &&
        !l.startsWith("✔ Updating files") &&
        !l.startsWith("+") &&
        l.length > 5
    );

    if (useful.length) return useful[useful.length - 1];
  }
  return "Unknown error";
}

function getDebugTail(err: unknown, maxLines = 12) {
  const { stderr = "", stdout = "", message = "" } = toCommandError(err);
  const raw = [stderr, stdout, message].filter(Boolean).join("\n").trim();
  if (!raw) return null;
  const lines = raw
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean);
  if (!lines.length) return null;
  return lines.slice(-maxLines).join("\n");
}

function extractMessageAndSuggestion(err: unknown) {
  const { stderr = "", stdout = "", message = "" } = toCommandError(err);
  const raw = [stderr, stdout, message].filter(Boolean).join("\n");
  if (!raw) return { detail: null as string | null, suggestion: null as string | null };

  const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
  let detail: string | null = null;
  let suggestion: string | null = null;

  const messageIndex = lines.findIndex((line) => line === "Message:");
  if (messageIndex >= 0 && lines[messageIndex + 1]) {
    detail = lines[messageIndex + 1];
  }

  const suggestionIndex = lines.findIndex((line) => line === "Suggestion:");
  if (suggestionIndex >= 0 && lines[suggestionIndex + 1]) {
    suggestion = lines[suggestionIndex + 1];
  }

  return { detail, suggestion };
}

type FailedEntry = { url: string; name: string; reason: string };
type CommandError = {
  stdout?: string;
  stderr?: string;
  message?: string;
  exitCode?: number | null;
};

function toCommandError(err: unknown): CommandError {
  if (!err || typeof err !== "object") return {};
  const value = err as Record<string, unknown>;
  return {
    stdout: typeof value.stdout === "string" ? value.stdout : undefined,
    stderr: typeof value.stderr === "string" ? value.stderr : undefined,
    message: typeof value.message === "string" ? value.message : undefined,
    exitCode: typeof value.exitCode === "number" ? value.exitCode : undefined,
  };
}

function isWorkspaceResolutionError(err: unknown) {
  const { stderr = "", stdout = "", message = "" } = toCommandError(err);
  const raw = `${stderr}\n${stdout}\n${message}`;

  return raw.includes('Workspace dependency "') || raw.includes("failed to resolve");
}

function isRegistryItemNotFoundError(err: unknown) {
  const { stderr = "", stdout = "", message = "" } = toCommandError(err);
  const raw = `${stderr}\n${stdout}\n${message}`;
  return raw.includes("The item at ") && raw.includes("was not found");
}

function isRetryableInstallError(err: unknown) {
  if (isWorkspaceResolutionError(err) || isRegistryItemNotFoundError(err)) return false;

  const { stderr = "", stdout = "", message = "" } = toCommandError(err);
  const raw = [stderr, stdout, message].join("\n");

  return (
    raw.includes("timed out") ||
    raw.includes("Failed to link") ||
    raw.includes("FileNotFound: Failed to open node_modules folder") ||
    raw.includes("EEXIST") ||
    raw.includes("Failed to install 1 package") ||
    raw.includes("ECONNRESET") ||
    raw.includes("ETIMEDOUT") ||
    raw.includes("network")
  );
}

function getComponentName(url: string) {
  return url.split("/").pop()?.replace(".json", "") ?? url;
}

function resolveExpectedInstallCandidates(cwd: string, target: string): string[] {
  const normalized = target.replace(/^\.?\//, "");
  const candidates = new Set<string>([
    join(cwd, normalized),
  ]);

  // Some setups write app/* targets under src/app/*.
  if (!normalized.startsWith("src/")) {
    candidates.add(join(cwd, "src", normalized));
  }

  return Array.from(candidates);
}

async function runBunInstall(cwd: string) {
  try {
    await $`bun install`.cwd(cwd).quiet();
    return { ok: true as const };
  } catch (err) {
    // Don't crash on install errors (workspace resolution, 404 packages, etc.)
    return { ok: false as const, workspaceError: isWorkspaceResolutionError(err) };
  }
}

async function runShadcnAdd(url: string, cwd: string, overwrite = false): Promise<void> {
  const name = getComponentName(url);
  const tmpRoot = join(tmpdir(), "uix-bunx-");
  const processTmpDir = mkdtempSync(tmpRoot);
  let target = url;
  let expectedTargets: string[] = [];

  if (/^https?:\/\//.test(url)) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const json = await res.json() as {
          name?: string;
          dependencies?: unknown;
          registryDependencies?: unknown;
          files?: Array<{ target?: unknown }>;
        };
        expectedTargets = Array.isArray(json.files)
          ? json.files
              .map((file) => (typeof file?.target === "string" ? file.target : null))
              .filter((target): target is string => Boolean(target))
          : [];
        const scopedSelfRef = (() => {
          try {
            const u = new URL(url);
            const scope = u.hostname.split(".")[0];
            return json.name ? `@${scope}/${json.name}` : null;
          } catch {
            return null;
          }
        })();
        const dependencies = Array.isArray(json.dependencies)
          ? json.dependencies
              .filter((dep): dep is string => typeof dep === "string")
              // normalize invalid package specs like "@hookform/resolvers/zod" -> "@hookform/resolvers"
              .map((dep) => dep.replace(/^(@[^/]+\/[^/]+)\/.+$/, "$1"))
              // drop obvious self-reference package entries (commonly invalid in custom registries)
              .filter((dep) => !scopedSelfRef || dep !== scopedSelfRef)
          : [];
        if (Array.isArray(json.registryDependencies) && json.registryDependencies.length > 0) {
          const patched = {
            ...json,
            dependencies,
            // Dependencies are handled by our own URL expansion in cli.ts.
            registryDependencies: [],
          };
          const localRegistryItem = join(processTmpDir, `${name}.json`);
          writeFileSync(localRegistryItem, JSON.stringify(patched, null, 2));
          target = localRegistryItem;
        } else if (dependencies.length > 0 && Array.isArray(json.dependencies)) {
          const patched = {
            ...json,
            dependencies,
          };
          const localRegistryItem = join(processTmpDir, `${name}.json`);
          writeFileSync(localRegistryItem, JSON.stringify(patched, null, 2));
          target = localRegistryItem;
        }
      }
    } catch {
      // Fallback to direct URL install if prefetch/patch fails.
    }
  }

  const cmd = ["bunx", "--bun", "shadcn@latest", "add", target, "-y"];
  if (overwrite) cmd.push("--overwrite");

  const proc = Bun.spawn(
    cmd,
    {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        TMPDIR: processTmpDir,
        TEMP: processTmpDir,
        TMP: processTmpDir,
      },
    }
  );

  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, INSTALL_TIMEOUT_MS);

  const exitCode = await proc.exited;
  clearTimeout(timeout);

  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  rmSync(processTmpDir, { recursive: true, force: true });

  if (timedOut) {
    const error: CommandError = {
      stdout,
      stderr,
      exitCode,
      message: `shadcn add timed out after ${INSTALL_TIMEOUT_MS / 1000}s`,
    };
    throw error;
  }

  const combined = `${stdout}\n${stderr}`;
  const notFoundError = isRegistryItemNotFoundError({ stderr, stdout, message: "" });
  if (notFoundError) {
    const error: CommandError = {
      stdout,
      stderr,
      exitCode,
      message: "Registry item not found",
    };
    throw error;
  }

  const created = combined.includes("✔ Created");
  const updated = combined.includes("✔ Updated");
  const skippedFiles = /skipped\s+\d+\s+files?/i.test(combined);
  const installed = isInstalled(name, cwd);
  const hasExpectedTarget = expectedTargets.some((fileTarget) =>
    resolveExpectedInstallCandidates(cwd, fileTarget).some((candidate) => existsSync(candidate))
  );
  const workspaceError = isWorkspaceResolutionError({ stderr, stdout, message: "" });

  // Some shadcn runs can return exitCode=0 even when Bun reports workspace-resolution failures.
  // If nothing was actually created/installed, treat that as a failure so summary/retry stays accurate.
  if (exitCode === 0 && workspaceError && !created && !installed && !hasExpectedTarget && !skippedFiles) {
    const error: CommandError = {
      stdout,
      stderr,
      exitCode,
      message: "Workspace dependency resolution failed during component install",
    };
    throw error;
  }

  if (exitCode === 0 && !created && !updated && !installed && !hasExpectedTarget && !skippedFiles) {
    const error: CommandError = {
      stdout,
      stderr,
      exitCode,
      message: "shadcn add reported success but component was not created",
    };
    throw error;
  }

  const hasFalseFailure = exitCode !== 0 && (created || updated || installed || hasExpectedTarget || skippedFiles);

  if (exitCode === 0 || hasFalseFailure) {
    return;
  }

  const error: CommandError = {
    stdout,
    stderr,
    exitCode,
    message: `shadcn add failed with exit code ${exitCode}`,
  };
  throw error;
}

async function installOne(url: string, cwd: string, attempts = INSTALL_ATTEMPTS, overwrite = false) {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await runShadcnAdd(url, cwd, overwrite);
      return;
    } catch (err) {
      lastError = err;
      if (attempt === attempts || !isRetryableInstallError(err)) {
        throw err;
      }
      await Bun.sleep(500 * attempt);
    }
  }

  throw lastError;
}

export async function installQueue(urls: string[], cwd: string, options?: InstallQueueOptions) {
  let success = 0;
  let failed = 0;
  let completed = 0;
  const failedEntries: FailedEntry[] = [];

  const total = urls.length;
  const spinner = ora().start();
  const start = Date.now();
  const concurrency = options?.concurrency ?? INSTALL_CONCURRENCY;
  const overwrite = options?.overwrite ?? true;
  const limit = pLimit(concurrency);

  function updateSpinner(current: string) {
    const pct = Math.round((completed / total) * 100);
    const elapsed = Date.now() - start;
    const avg = completed > 0 ? elapsed / completed : 0;
    const remaining = avg * (total - completed);
    const eta = completed > 0 ? formatEta(remaining) : "calculating...";

    spinner.text = `${chalk.cyan(current)} ${chalk.gray(
      `[${completed}/${total}] ${pct}% • ETA ${eta}`
    )}`;
  }

  await Promise.all(
    urls.map((url) =>
      limit(async () => {
        const name = getComponentName(url);
        updateSpinner(name);

        try {
          await installOne(url, cwd, INSTALL_ATTEMPTS, overwrite);
          success++;
        } catch (err) {
          failed++;
          const cmdErr = toCommandError(err);
          const reason = extractError(err);
          failedEntries.push({ url, name, reason });
          const detail = extractMessageAndSuggestion(err);
          if (detail.detail || detail.suggestion) {
            p.log.error(`${name} failed`);
            p.log.message(
              [
                detail.detail ? `Message: ${detail.detail}` : null,
                detail.suggestion ? `Suggestion: ${detail.suggestion}` : null,
              ].filter(Boolean).join("\n")
            );
          }
          const debugTail = getDebugTail(err);
          if (!detail.detail && !detail.suggestion && debugTail) {
            p.log.warn(`${name} raw output`);
            p.log.message(chalk.gray(debugTail));
          } else if (!detail.detail && !detail.suggestion && cmdErr.exitCode !== undefined && cmdErr.exitCode !== null) {
            p.log.error(`${name} failed`);
            p.log.message(`exitCode=${cmdErr.exitCode}`);
          }
        }

        completed++;
        updateSpinner(name);
      })
    )
  );

  // deps install
  spinner.text = chalk.cyan("Running bun install...");
  const installResult = await runBunInstall(cwd);
  if (installResult.ok) {
    spinner.succeed("Dependencies installed");
  } else {
    spinner.warn("Components installed, but Bun could not resolve dependencies");
    p.log.warn(
      `Manual action required: fix unresolved dependencies in ${cwd} and rerun bun install.`
    );
  }

  spinner.stop();

  // save or clear failed list
  const failedUrls = failedEntries.map((e) => e.url);
  saveFailed(failedUrls, cwd);

  const time = ((Date.now() - start) / 1000).toFixed(2);

  p.log.step("Summary");
  p.log.message([
    `${chalk.green("✔")} Success: ${success}`,
    `${chalk.red("✖")} Failed:  ${failed}`,
    `⏱ Time:    ${time}s`,
  ]);

  if (failedEntries.length > 0) {
    p.log.step("Failed component(s)");
    p.log.message(chalk.white(formatComponentList(failedEntries.map((entry) => entry.name))));
    p.log.error("Failure details");
    for (const entry of failedEntries) {
      p.log.message(`  ${chalk.red("✖")} ${chalk.white(entry.name)}\n    ${chalk.gray(entry.reason)}`);
    }
    p.log.info("Run retry to retry only failed ones.");
  }

  return { success, failed, failedUrls };
}
