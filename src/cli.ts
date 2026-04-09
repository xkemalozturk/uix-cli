#!/usr/bin/env bun
import { buildInstallList, resolveItemSourceUrl } from "./core";
import { installQueue } from "./installer";
import { initPackage } from "./init";
import { resolveRegistryUrl, fetchRegistryAliases, hasStyleParam, fetchRegistryStyles, getRegistryPattern } from "./resolve-registry";
import { resolve, join, basename } from "path";
import chalk from "chalk";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "fs";
import { $ } from "bun";
import type { RegistryItem, RegistryPayload } from "./types";
import {
  checkComponentUpdates,
  loadFailed,
  loadInstallFailedSources,
  patchComponentStateWithKnownHashes,
  reconcileInstallStateBySource,
  resolveInstallTargetsFromState,
  saveFailed,
  upsertComponentState,
  type InstalledComponentSource,
} from "./component-state";
import { isInstalled } from "./utils";

function ensureFlatUiAlias(cwd: string) {
  const componentsPath = join(cwd, "components.json");
  if (!existsSync(componentsPath)) return;

  try {
    const raw = readFileSync(componentsPath, "utf-8");
    const config = JSON.parse(raw) as {
      aliases?: Record<string, unknown>;
    };
    const aliases = config.aliases;
    if (!aliases) return;

    const aliasPrefix = resolveImportAliasPrefix(cwd);
    const desiredComponents = `${aliasPrefix}/components`;
    const desiredLib = `${aliasPrefix}/lib`;
    const desiredHooks = `${aliasPrefix}/hooks`;
    const desiredUtils = `${desiredLib}/utils`;
    let changed = false;

    if (aliases.components !== desiredComponents) {
      aliases.components = desiredComponents;
      changed = true;
    }
    if (aliases.ui !== desiredComponents) {
      aliases.ui = desiredComponents;
      changed = true;
    }
    if (aliases.lib !== desiredLib) {
      aliases.lib = desiredLib;
      changed = true;
    }
    if (aliases.hooks !== desiredHooks) {
      aliases.hooks = desiredHooks;
      changed = true;
    }
    if (aliases.utils !== desiredUtils) {
      aliases.utils = desiredUtils;
      changed = true;
    }

    if (changed) {
      writeFileSync(componentsPath, JSON.stringify(config, null, 2));
    }
  } catch {
    // Skip silently when components.json is malformed.
  }
}

function moveTree(fromPath: string, toPath: string) {
  if (!existsSync(fromPath)) return;

  const entries = readdirSync(fromPath, { withFileTypes: true });
  mkdirSync(toPath, { recursive: true });

  for (const entry of entries) {
    const fromEntry = join(fromPath, entry.name);
    const toEntry = join(toPath, entry.name);

    if (entry.isDirectory()) {
      moveTree(fromEntry, toEntry);
      rmSync(fromEntry, { recursive: true, force: true });
      continue;
    }

    if (!existsSync(toEntry)) {
      renameSync(fromEntry, toEntry);
    }
  }
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getScopedAliasRoot(aliasPrefix: string): string | null {
  if (!aliasPrefix.startsWith("@")) return null;
  const slashIndex = aliasPrefix.indexOf("/");
  if (slashIndex <= 0) return null;
  return aliasPrefix.slice(0, slashIndex);
}

function normalizeAliasPrefix(aliasPrefix: string, cwdForFallback?: string) {
  const trimmed = aliasPrefix.trim().replace(/\/+$/, "");
  if (!trimmed) return "@";

  // Normalize invalid scoped names like "@workspace" to "@workspace/<folder>".
  if (/^@[^/]+$/.test(trimmed) && cwdForFallback) {
    const folderName = basename(cwdForFallback).trim();
    if (folderName) return `${trimmed}/${folderName}`;
  }

  return trimmed;
}

function rewriteImportsInDir(dir: string, aliasPrefix: string) {
  if (!existsSync(dir)) return;
  const normalizedAliasPrefix = normalizeAliasPrefix(aliasPrefix);
  const scopedAliasRoot = getScopedAliasRoot(normalizedAliasPrefix);
  const escapedScopedAliasRoot = scopedAliasRoot ? escapeRegExp(scopedAliasRoot) : null;

  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      rewriteImportsInDir(fullPath, aliasPrefix);
      continue;
    }

    if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)) continue;

    const source = readFileSync(fullPath, "utf-8");
    let updated = source
      .replace(/(["'])@\/components\/ui(?=\/|["'])/g, `$1${normalizedAliasPrefix}/components`)
      .replace(/(["'])@\/(?=[^"']+)/g, `$1${normalizedAliasPrefix}/`);

    if (escapedScopedAliasRoot) {
      updated = updated
        .replace(
          new RegExp(`(["'])${escapedScopedAliasRoot}\\/components\\/ui(?=\\/|["'])`, "g"),
          `$1${normalizedAliasPrefix}/components`
        )
        .replace(
          new RegExp(`(["'])${escapedScopedAliasRoot}\\/(components|lib|hooks)(?=\\/|["'])`, "g"),
          `$1${normalizedAliasPrefix}/$2`
        );
    }

    if (updated !== source) {
      writeFileSync(fullPath, updated);
    }
  }
}

function resolveImportAliasPrefix(cwd: string): string {
  const packagePath = join(cwd, "package.json");
  if (existsSync(packagePath)) {
    try {
      const raw = readFileSync(packagePath, "utf-8");
      const pkg = JSON.parse(raw) as { name?: unknown };
      if (typeof pkg.name === "string" && pkg.name.trim()) {
        return normalizeAliasPrefix(pkg.name, cwd);
      }
    } catch {
      // Ignore malformed package.json and fall back to @ alias.
    }
  }

  return "@";
}

function normalizeInstalledComponentPaths(cwd: string) {
  const pairs = [
    { uiDir: join(cwd, "components", "ui"), target: join(cwd, "components") },
    { uiDir: join(cwd, "src/components", "ui"), target: join(cwd, "src/components") },
  ];

  for (const pair of pairs) {
    if (!existsSync(pair.uiDir)) continue;
    moveTree(pair.uiDir, pair.target);
    rmSync(pair.uiDir, { recursive: true, force: true });
  }

  const aliasPrefix = resolveImportAliasPrefix(cwd);
  rewriteImportsInDir(join(cwd, "components"), aliasPrefix);
  rewriteImportsInDir(join(cwd, "app"), aliasPrefix);
  rewriteImportsInDir(join(cwd, "hooks"), aliasPrefix);
  rewriteImportsInDir(join(cwd, "lib"), aliasPrefix);
  rewriteImportsInDir(join(cwd, "src"), aliasPrefix);
}

async function runNativeShadcnAdd(cwd: string, all: boolean) {
  ensureFlatUiAlias(cwd);

  const cmd = all
    ? ["bunx", "--bun", "shadcn@latest", "add", "--all", "-y"]
    : ["bunx", "--bun", "shadcn@latest", "add"];

  const proc = Bun.spawn(cmd, {
    cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`shadcn add failed with exit code ${exitCode}`);
  }

  normalizeInstalledComponentPaths(cwd);
}

function guessPattern(url: string) {
  const parts = url.split("/");
  const last = parts.pop() || "";
  const base = parts.join("/");

  if (last.endsWith(".json")) {
    return `${base}/{name}.json`;
  }

  return `${base}/{name}`;
}

async function fetchRegistry(url: string) {
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Registry request failed with ${res.status} ${res.statusText}: ${url}`);
  }

  const body = await res.text();

  if (!body.trim()) {
    throw new Error(`Registry returned an empty response: ${url}`);
  }

  let json: RegistryPayload;
  try {
    json = JSON.parse(body) as RegistryPayload;
  } catch {
    throw new Error(`Registry returned invalid JSON: ${url}`);
  }

  if (Array.isArray(json)) return json;
  if (Array.isArray(json.items)) return json.items;

  throw new Error(`Invalid registry format: ${url}`);
}

function getRegistryBaseFromSource(sourceUrl: string): string {
  const slash = sourceUrl.lastIndexOf("/");
  return slash >= 0 ? sourceUrl.slice(0, slash) : sourceUrl;
}

function getRegistryIndexUrl(sourceUrl: string): string {
  return `${getRegistryBaseFromSource(sourceUrl)}/registry.json`;
}

async function expandInstallTargetsWithRegistryDeps(targets: string[]): Promise<string[]> {
  const ordered: string[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const registryNameCache = new Map<string, Set<string> | null>();

  async function loadRegistryNames(sourceUrl: string): Promise<Set<string> | null> {
    const registryUrl = getRegistryIndexUrl(sourceUrl);
    if (registryNameCache.has(registryUrl)) {
      return registryNameCache.get(registryUrl) ?? null;
    }

    try {
      const res = await fetch(registryUrl);
      if (!res.ok) {
        registryNameCache.set(registryUrl, null);
        return null;
      }
      const payload = await res.json() as { items?: Array<{ name?: string }> } | Array<{ name?: string }>;
      const items = Array.isArray(payload)
        ? payload
        : Array.isArray(payload.items)
          ? payload.items
          : [];
      const names = new Set(
        items
          .map((item) => item?.name)
          .filter((name): name is string => Boolean(name))
      );
      registryNameCache.set(registryUrl, names);
      return names;
    } catch {
      registryNameCache.set(registryUrl, null);
      return null;
    }
  }

  async function resolveDependencyTarget(dep: string, sourceUrl: string): Promise<string> {
    if (/^https?:\/\//.test(dep)) return dep;

    const registryNames = await loadRegistryNames(sourceUrl);
    if (!registryNames) return dep;

    const tail = dep.startsWith("@") ? dep.split("/").pop() ?? dep : dep;
    const candidates = dep.startsWith("@") ? [dep, tail] : [dep];
    const found = candidates.find((candidate) => registryNames.has(candidate));
    if (!found) return dep;

    return `${getRegistryBaseFromSource(sourceUrl)}/${found.replace(/\.json$/, "")}.json`;
  }

  async function visit(target: string): Promise<void> {
    if (visited.has(target)) return;
    if (visiting.has(target)) return;
    visiting.add(target);

    if (/^https?:\/\//.test(target)) {
      try {
        const res = await fetch(target);
        if (res.ok) {
          const json = await res.json() as { registryDependencies?: string[] };
          const deps = Array.isArray(json.registryDependencies) ? json.registryDependencies : [];
          for (const dep of deps) {
            const depTarget = await resolveDependencyTarget(dep, target);
            await visit(depTarget);
          }
        }
      } catch {
        // Ignore dependency expansion errors and continue with original target.
      }
    }

    visiting.delete(target);
    visited.add(target);
    ordered.push(target);
  }

  for (const target of targets) {
    await visit(target);
  }

  return ordered;
}

async function promptComponentSelection(rawRegistry: string, style?: string): Promise<string[]> {
  const registryUrl = await resolveStyledRegistryUrl(rawRegistry, style);

  let items: RegistryItem[] | null = null;
  let registryListUnavailable = false;
  try {
    items = await fetchRegistry(registryUrl);
  } catch {
    registryListUnavailable = true;
    // Registry doesn't have a listing endpoint (e.g. reui with {style} in URL)
  }

  if (items && items.length > 0) {
    const componentNames = items
      .map((item) => item.name)
      .filter((name): name is string => Boolean(name))
      .sort((a, b) => a.localeCompare(b));

    if (componentNames.length) {
      const selected = await p.multiselect({
        message: "Select component(s) to install:",
        options: componentNames.map((name) => ({
          label: name,
          value: name,
        })),
        required: true,
      });

      if (p.isCancel(selected)) {
        p.cancel("Operation cancelled.");
        process.exit(0);
      }

      return selected;
    }
  }

  // Fallback: manual input for registries without a listing endpoint
  if (registryListUnavailable) {
    const styleNote = style ? ` (style: ${style})` : "";
    p.log.warn(`Component list unavailable${styleNote}. Enter component name(s) manually.`);
  }

  const input = await p.text({
    message: "Enter component name(s) to install (space-separated):",
    placeholder: "button card dialog",
    validate: (value) => {
      if (!value?.trim()) return "Please enter at least one component name";
    },
  });

  if (p.isCancel(input)) {
    p.cancel("Operation cancelled.");
    process.exit(0);
  }

  return input.split(/\s+/).filter(Boolean);
}

/**
 * Resolve registry URL, replacing {style} if a style is selected.
 */
async function resolveStyledRegistryUrl(rawRegistry: string, style?: string): Promise<string> {
  const url = await resolveRegistryUrl(rawRegistry);
  if (style) {
    // If the original pattern has {style}, reconstruct URL with style
    const pattern = getRegistryPattern(rawRegistry);
    if (pattern && pattern.includes("{style}")) {
      return pattern
        .replace("{style}", style)
        .replace("{name}.json", "registry.json")
        .replace("{name}", "registry");
    }
  }
  return url;
}

function isProjectEmpty(cwd: string) {
  const pkgPath = join(cwd, "package.json");
  if (!existsSync(pkgPath)) return true;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    const hasDeps = Object.keys(pkg.dependencies || {}).length > 0 ||
      Object.keys(pkg.devDependencies || {}).length > 0;
    return !hasDeps;
  } catch {
    return true;
  }
}

function getComponentNameFromTarget(target: string): string | null {
  const token = target.split("/").pop();
  if (!token) return null;
  return token.replace(".json", "") || null;
}

function isRetryTargetInstalled(target: string, cwd: string) {
  const name = getComponentNameFromTarget(target);
  if (!name) return false;
  return isInstalled(name, cwd);
}

async function resolveInstalledSources(
  installRefs: string[],
  items: RegistryItem[],
  pattern: string,
  registryName?: string | null
): Promise<InstalledComponentSource[]> {
  if (!registryName) {
    return installRefs
      .filter((installRef) => /^https?:\/\//.test(installRef))
      .map((installRef) => ({
        installRef,
        sourceUrl: installRef,
      }));
  }

  const byName = new Map(
    items
      .filter((item): item is RegistryItem & { name: string } => Boolean(item.name))
      .map((item) => [item.name, item])
  );

  const entries: InstalledComponentSource[] = [];
  const prefix = `${registryName}/`;

  for (const installRef of installRefs) {
    if (!installRef.startsWith(prefix)) continue;
    const name = installRef.slice(prefix.length);
    const item = byName.get(name);
    if (!item) continue;

    const sourceUrl = await resolveItemSourceUrl(item, pattern);
    if (!sourceUrl) continue;

    entries.push({
      installRef,
      sourceUrl,
    });
  }

  return entries;
}

async function runComponentUpdateMode(cwd: string, shouldUpdate: boolean) {
  const result = await checkComponentUpdates(cwd);

  if (result.trackedCount === 0) {
    p.log.warn("No tracked components found. Install components first to enable update checks.");
    return;
  }

  if (result.failed.length > 0) {
    p.log.warn(`Could not check ${result.failed.length} component(s):`);
    for (const failure of result.failed) {
      p.log.message(`  ${chalk.red("✖")} ${chalk.white(failure.installRef)}\n    ${chalk.gray(failure.reason)}`);
    }
  }

  if (result.updates.length === 0) {
    p.log.success("All tracked components are up to date.");
    return;
  }

  p.log.step(`Updates available for ${result.updates.length} component(s):`);
  for (const update of result.updates) {
    p.log.message(`  ${chalk.cyan(update.installRef)}`);
  }

  if (!shouldUpdate) return;

  const installTargets = result.updates.map((update) => update.sourceUrl);
  const expandedInstallTargets = await expandInstallTargetsWithRegistryDeps(installTargets);
  p.log.step(`Updating ${expandedInstallTargets.length} component(s)`);
  const installResult = await installQueue(expandedInstallTargets, cwd, { overwrite: true });
  const failedSourceSet = new Set(installResult.failedUrls);
  const failedInstallRefs = result.updates
    .filter((update) => failedSourceSet.has(update.sourceUrl))
    .map((update) => update.installRef);
  patchComponentStateWithKnownHashes(cwd, result.updates, failedInstallRefs);
  normalizeInstalledComponentPaths(cwd);
}

async function main() {
  const args = process.argv.slice(2);

  const retry = args.includes("retry");
  const dry = args.includes("--dry");
  const noDiff = args.includes("--no-diff");
  const outdated = args.includes("outdated");
  const update = args.includes("update");
  const nativeShadcnCommand = args[0] === "init" && args[1] === "shadcn";
  const useNativeShadcn = nativeShadcnCommand || args.includes("--shadcn");
  const nativeShadcnAll = args.includes("--all");

  const isInit = args[0] === "init" && !nativeShadcnCommand;
  const isList = args[0] === "list" || args.includes("--list");
  let targetCwd = process.cwd();

  const cwdArg = args.find((a) => a.startsWith("--cwd="));
  if (cwdArg) {
    targetCwd = resolve(process.cwd(), cwdArg.split("=")[1]);
  } else if (useNativeShadcn) {
    const monorepoUiDir = resolve(process.cwd(), "packages/ui");
    if (existsSync(monorepoUiDir) && existsSync(join(monorepoUiDir, "package.json"))) {
      targetCwd = monorepoUiDir;
    }
  }

  // Interactive mode if no arguments or only certain flags are provided
  if (args.length === 0 || (args.length === 1 && args[0].startsWith("--cwd="))) {
    p.intro(pc.bgCyan(pc.black(" UIX ")));

    if (isProjectEmpty(targetCwd)) {
      const shouldInit = await p.confirm({
        message: "Project is empty. Do you want to initialize shadcn?",
        initialValue: true,
      });

      if (p.isCancel(shouldInit)) {
        p.cancel("Operation cancelled.");
        process.exit(0);
      }

      if (shouldInit) {
        const s = p.spinner();
        s.start("Running shadcn init...");
        try {
          await $`bunx --bun shadcn@latest init`.cwd(targetCwd);
          s.stop("Shadcn initialized successfully!");
        } catch {
          s.stop("Failed to initialize shadcn.");
          process.exit(1);
        }
      }
    }

    const group = await p.group(
      {
        repoName: () => p.text({
          message: "What is the name of the package?",
          placeholder: "@workspace/ui",
          validate: (value) => {
            if (!value) return "Please enter a name";
          }
        }),
        folderPath: () => p.text({
          message: "Where should it be installed?",
          placeholder: "packages/ui",
          validate: (value) => {
            if (!value) return "Please enter a path";
          }
        }),
        registry: async () => {
          const aliases = await fetchRegistryAliases();
          return p.select({
            message: "Select a UI library to install:",
            options: Object.entries(aliases).map(([name, url]) => ({
              label: name,
              value: name,
            })),
          });
        },
      },
      {
        onCancel: () => {
          p.cancel("Operation cancelled.");
          process.exit(0);
        },
      }
    );

    // Run init sequence based on interactive input
    await initPackage(group.repoName, group.folderPath);
    targetCwd = resolve(process.cwd(), group.folderPath);

    // Check if registry has {style} parameter and prompt for style selection
    // fetchRegistryAliases must be called first to populate ORIGINAL_PATTERNS
    let selectedStyle: string | undefined;
    if (hasStyleParam(group.registry)) {
      const styles = await fetchRegistryStyles(group.registry);
      if (styles.length > 0) {
        const style = await p.select({
          message: "Select a style:",
          options: styles.map((s) => ({
            label: s.label,
            value: s.name,
          })),
        });

        if (p.isCancel(style)) {
          p.cancel("Operation cancelled.");
          process.exit(0);
        }

        selectedStyle = style;
      }
    }

    // Ask component selection and install only selected items.
    const selectedComponents = await promptComponentSelection(group.registry, selectedStyle);
    await processInstallation(group.registry, targetCwd, noDiff, dry, selectedComponents, true, selectedStyle);

    p.outro(pc.green("Installation completed successfully!"));
    return;
  }

  if (isList) {
    p.log.step("Fetching registries...");
    const aliases = await fetchRegistryAliases();
    p.log.step("Available Registries:");
    for (const [name, url] of Object.entries(aliases)) {
      p.log.message(`  ${chalk.cyan(name.padEnd(20))} ${chalk.gray(url)}`);
    }
    p.log.info("Usage: bunx uix <registry-alias>");
    process.exit(0);
  }

  // retry mode: install only previously failed URLs
  if (retry) {
    const failedState = loadFailed(targetCwd);
    const failedUrls = failedState.urls;
    const installFailedSources = loadInstallFailedSources(targetCwd);
    const rawTargets = resolveInstallTargetsFromState(
      targetCwd,
      Array.from(new Set([...failedUrls, ...installFailedSources]))
    );
    const retryTargets = rawTargets.filter((target) => !isRetryTargetInstalled(target, targetCwd));
    const skippedAlreadyInstalled = rawTargets.length - retryTargets.length;

    if (retryTargets.length === 0) {
      // Clear stale failed URL list when everything is already present locally.
      if (failedUrls.length > 0) {
        saveFailed([], targetCwd);
      }
      p.log.success("No failed components to retry.");
      process.exit(0);
    }

    p.log.step(`Retrying ${retryTargets.length} failed component(s)`);
    if (installFailedSources.length > 0) {
      p.log.message(chalk.gray(`(including ${installFailedSources.length} from install_failed state)`));
    }
    if (skippedAlreadyInstalled > 0) {
      p.log.message(chalk.gray(`(skipped ${skippedAlreadyInstalled} already installed component(s))`));
    }

    const installResult = await installQueue(retryTargets, targetCwd, { overwrite: true });
    await reconcileInstallStateBySource(targetCwd, retryTargets, installResult.failedUrls);
    process.exit(0);
  }

  if (outdated || update) {
    await runComponentUpdateMode(targetCwd, update);
    process.exit(0);
  }

  if (nativeShadcnCommand) {
    try {
      await runNativeShadcnAdd(targetCwd, nativeShadcnAll);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      p.log.error(message);
      process.exit(1);
    }
    process.exit(0);
  }

  if (isInit) {
    const nameArg = args.find((a) => a.startsWith("--name="));
    const dirArg = args.find((a) => a.startsWith("--dir="));

    if (!nameArg || !dirArg) {
      p.log.error("Usage: bunx uix init --name=<package-name> --dir=<target-dir> [registry-url]");
      process.exit(1);
    }

    const name = nameArg.split("=")[1];
    const dir = dirArg.split("=")[1];

    await initPackage(name, dir);
    targetCwd = resolve(process.cwd(), dir);

    const maybeUrl = args.find((a) => !a.startsWith("--") && a !== "init");
    if (!maybeUrl) {
      if (useNativeShadcn) {
        try {
          await runNativeShadcnAdd(targetCwd, nativeShadcnAll);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          p.log.error(message);
          process.exit(1);
        }
      }
      process.exit(0);
    }
    // If URL is provided, continue the normal installation flow inside the init dir.
    const urlIndex = args.indexOf(maybeUrl);
    args[urlIndex] = maybeUrl; // Just visual consistency
  }

  const rawUrl = args.find((a) => !a.startsWith("--") && a !== "init" && a !== "list" && a !== "shadcn");

  if (useNativeShadcn) {
    try {
      await runNativeShadcnAdd(targetCwd, nativeShadcnAll);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      p.log.error(message);
      process.exit(1);
    }
    process.exit(0);
  }

  if (!rawUrl) {
    p.log.error("Usage: bunx uix <url|alias> [--dry] [--no-diff] [retry] [--cwd=<dir>]");
    p.log.message("       bunx uix [outdated|update] [--cwd=<dir>]");
    p.log.message("       bunx uix init shadcn [--all] [--cwd=<dir>]");
    p.log.message("       bunx uix init --name=<name> --dir=<dir> [url|alias] [--all]");
    p.log.message("       bunx uix list");
    process.exit(1);
  }

  await processInstallation(rawUrl, targetCwd, noDiff, dry);
}

async function processInstallation(
  rawUrl: string,
  targetCwd: string,
  noDiff: boolean,
  dry: boolean,
  selectedComponents?: string[],
  sequentialInstall = false,
  selectedStyle?: string
) {
  ensureFlatUiAlias(targetCwd);

  let url: string;
  try {
    url = await resolveStyledRegistryUrl(rawUrl, selectedStyle);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    p.log.error(message);
    process.exit(1);
  }

  let items: RegistryItem[];

  if (selectedComponents?.length) {
    // When components were manually selected, try fetching registry listing
    // but fall back to constructing items from selections if it fails
    try {
      const allItems = await fetchRegistry(url);
      const selectedSet = new Set(selectedComponents);
      items = allItems.filter((item) => item.name && selectedSet.has(item.name));
    } catch {
      // Registry has no listing endpoint — build items from selected names
      items = selectedComponents.map((name) => ({ name }));
    }

    if (!items.length) {
      p.log.error("Selected components were not found in this registry.");
      process.exit(1);
    }
  } else {
    try {
      items = await fetchRegistry(url);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      p.log.error(message);
      process.exit(1);
    }
  }

  const originalPattern = getRegistryPattern(rawUrl);
  const pattern = (() => {
    if (!originalPattern) return guessPattern(url);

    if (originalPattern.includes("{style}")) {
      if (selectedStyle) return originalPattern.replace("{style}", selectedStyle);
      return originalPattern
        .replace("{style}/", "")
        .replace("/{style}", "")
        .replace("{style}", "");
    }

    return originalPattern;
  })();

  const urls = await buildInstallList(
    items,
    pattern,
    targetCwd,
    selectedComponents?.length ? false : !noDiff,
    null
  );

  if (dry) {
    urls.forEach((u) => p.log.message(u, { symbol: "│" }));
    process.exit(0);
  }

  const expandedUrls = await expandInstallTargetsWithRegistryDeps(urls);
  p.log.step(`Installing ${expandedUrls.length} components`);

  const installResult = await installQueue(expandedUrls, targetCwd, {
    concurrency: sequentialInstall ? 1 : undefined,
  });

  const installedSources = await resolveInstalledSources(expandedUrls, items, pattern, null);
  await upsertComponentState(targetCwd, installedSources, installResult.failedUrls);

  normalizeInstalledComponentPaths(targetCwd);
}

main();
