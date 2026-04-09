import { createHash } from "crypto";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { isInstalled } from "./utils";

const REGISTRY_STATE_FILE = "registry-state.json";
const LEGACY_COMPONENT_STATE_FILE = "registry-components.json";
const LEGACY_FAILED_STATE_FILE = "registry-failed.json";
const REMOTE_TIMEOUT_MS = 15_000;

export type ComponentStatus =
  | "up_to_date"
  | "outdated"
  | "check_failed"
  | "install_failed";

export type ComponentStateEntry = {
  installRef: string;
  sourceUrl: string;
  hash: string;
  updatedAt: string;
  status: ComponentStatus;
  lastCheckAt?: string;
  lastError?: string;
};

export type FailedState = {
  cwd: string | null;
  urls: string[];
  updatedAt?: string;
};

type RegistryStateFile = {
  version: 1;
  failed: FailedState;
  components: Record<string, ComponentStateEntry>;
};

export type ComponentUpdate = {
  installRef: string;
  sourceUrl: string;
  previousHash: string;
  latestHash: string;
};

function getStatePath(cwd: string) {
  return join(cwd, REGISTRY_STATE_FILE);
}

function getDefaultFailedState(): FailedState {
  return {
    cwd: null,
    urls: [],
  };
}

function getDefaultState(): RegistryStateFile {
  return {
    version: 1,
    failed: getDefaultFailedState(),
    components: {},
  };
}

function hashContent(content: string) {
  return createHash("sha256").update(content).digest("hex");
}

function loadLegacyComponentState(cwd: string): Record<string, ComponentStateEntry> {
  const path = join(cwd, LEGACY_COMPONENT_STATE_FILE);
  if (!existsSync(path)) return {};

  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as { components?: Record<string, ComponentStateEntry> };
    if (!parsed.components || typeof parsed.components !== "object") return {};

    const now = new Date().toISOString();
    const normalized: Record<string, ComponentStateEntry> = {};
    for (const [key, entry] of Object.entries(parsed.components)) {
      normalized[key] = {
        ...entry,
        status: entry.status ?? "up_to_date",
        lastCheckAt: entry.lastCheckAt ?? now,
      };
    }
    return normalized;
  } catch {
    return {};
  }
}

function loadLegacyFailedState(cwd: string): FailedState {
  const path = join(cwd, LEGACY_FAILED_STATE_FILE);
  if (!existsSync(path)) return getDefaultFailedState();

  try {
    const data = JSON.parse(readFileSync(path, "utf-8"));
    if (Array.isArray(data)) {
      return { cwd: null, urls: data };
    }
    return {
      cwd: typeof data.cwd === "string" ? data.cwd : null,
      urls: Array.isArray(data.urls) ? data.urls : [],
    };
  } catch {
    return getDefaultFailedState();
  }
}

function loadRegistryState(cwd: string): RegistryStateFile {
  const statePath = getStatePath(cwd);
  if (!existsSync(statePath)) {
    return {
      version: 1,
      components: loadLegacyComponentState(cwd),
      failed: loadLegacyFailedState(cwd),
    };
  }

  try {
    const raw = readFileSync(statePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<RegistryStateFile>;
    const components = parsed.components && typeof parsed.components === "object"
      ? parsed.components
      : {};
    const failed = parsed.failed && typeof parsed.failed === "object"
      ? parsed.failed
      : getDefaultFailedState();

    return {
      version: 1,
      failed: {
        cwd: typeof failed.cwd === "string" ? failed.cwd : null,
        urls: Array.isArray(failed.urls) ? failed.urls : [],
        updatedAt: typeof failed.updatedAt === "string" ? failed.updatedAt : undefined,
      },
      components: components as Record<string, ComponentStateEntry>,
    };
  } catch {
    return getDefaultState();
  }
}

function saveRegistryState(cwd: string, state: RegistryStateFile) {
  const statePath = getStatePath(cwd);
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

export function loadFailed(cwd: string): FailedState {
  return loadRegistryState(cwd).failed;
}

export function loadInstallFailedRefs(cwd: string): string[] {
  const state = loadRegistryState(cwd);
  return Object.values(state.components)
    .filter((entry) => entry.status === "install_failed")
    .map((entry) => entry.installRef);
}

export function loadInstallFailedSources(cwd: string): string[] {
  const state = loadRegistryState(cwd);
  return Object.values(state.components)
    .filter((entry) => entry.status === "install_failed")
    .map((entry) => entry.sourceUrl);
}

export function resolveInstallTargetsFromState(cwd: string, targets: string[]): string[] {
  const state = loadRegistryState(cwd);
  return Array.from(
    new Set(
      targets.map((target) => state.components[target]?.sourceUrl ?? target)
    )
  );
}

export function saveFailed(urls: string[], cwd: string) {
  const state = loadRegistryState(cwd);
  state.failed = {
    cwd,
    urls,
    updatedAt: new Date().toISOString(),
  };
  saveRegistryState(cwd, state);
}

async function fetchRemoteHash(url: string): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REMOTE_TIMEOUT_MS);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`Remote fetch failed with ${res.status} ${res.statusText}: ${url}`);
    }
    const body = await res.text();
    return hashContent(body);
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function checkComponentUpdates(cwd: string) {
  const state = loadRegistryState(cwd);
  const entries = Object.values(state.components);

  const updates: ComponentUpdate[] = [];
  const failed: Array<{ installRef: string; sourceUrl: string; reason: string }> = [];
  const now = new Date().toISOString();

  for (const entry of entries) {
    if (!isInstallRefPresentLocally(entry.installRef, cwd)) {
      const reason = "Component files were not found locally.";
      state.components[entry.installRef] = {
        ...entry,
        status: "install_failed",
        lastCheckAt: now,
        lastError: reason,
      };
      failed.push({
        installRef: entry.installRef,
        sourceUrl: entry.sourceUrl,
        reason,
      });
      continue;
    }

    try {
      const latestHash = await fetchRemoteHash(entry.sourceUrl);
      if (latestHash !== entry.hash) {
        state.components[entry.installRef] = {
          ...entry,
          status: "outdated",
          lastCheckAt: now,
          lastError: undefined,
        };
        updates.push({
          installRef: entry.installRef,
          sourceUrl: entry.sourceUrl,
          previousHash: entry.hash,
          latestHash,
        });
      } else {
        state.components[entry.installRef] = {
          ...entry,
          status: "up_to_date",
          lastCheckAt: now,
          lastError: undefined,
        };
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      state.components[entry.installRef] = {
        ...entry,
        status: "check_failed",
        lastCheckAt: now,
        lastError: reason,
      };
      failed.push({
        installRef: entry.installRef,
        sourceUrl: entry.sourceUrl,
        reason,
      });
    }
  }

  saveRegistryState(cwd, state);

  return {
    trackedCount: entries.length,
    updates,
    failed,
  };
}

export type InstalledComponentSource = {
  installRef: string;
  sourceUrl: string;
};

function getComponentNameFromInstallRef(installRef: string): string | null {
  const token = installRef.split("/").pop();
  if (!token) return null;
  return token.replace(".json", "") || null;
}

function isInstallRefPresentLocally(installRef: string, cwd: string) {
  const name = getComponentNameFromInstallRef(installRef);
  if (!name) return false;
  return isInstalled(name, cwd);
}

export async function upsertComponentState(
  cwd: string,
  installedSources: InstalledComponentSource[],
  failedInstallRefs: string[]
) {
  const failedSet = new Set(failedInstallRefs);
  const state = loadRegistryState(cwd);
  const now = new Date().toISOString();

  for (const failedRef of failedSet) {
    const existing = state.components[failedRef];
    if (!existing) continue;
    state.components[failedRef] = {
      ...existing,
      status: "install_failed",
      lastCheckAt: now,
      lastError: "Component installation failed.",
    };
  }

  for (const source of installedSources) {
    if (failedSet.has(source.installRef)) continue;

    if (!isInstallRefPresentLocally(source.installRef, cwd)) {
      const existing = state.components[source.installRef];
      state.components[source.installRef] = {
        ...(existing ?? {
          installRef: source.installRef,
          sourceUrl: source.sourceUrl,
          hash: existing?.hash ?? "",
          updatedAt: existing?.updatedAt ?? now,
        }),
        status: "install_failed",
        lastCheckAt: now,
        lastError: "Component files were not found after install.",
      };
      continue;
    }

    try {
      const hash = await fetchRemoteHash(source.sourceUrl);
      state.components[source.installRef] = {
        installRef: source.installRef,
        sourceUrl: source.sourceUrl,
        hash,
        updatedAt: now,
        status: "up_to_date",
        lastCheckAt: now,
        lastError: undefined,
      };
    } catch {
      // Skip state update for entries that cannot be fetched right now.
    }
  }

  saveRegistryState(cwd, state);
}

export function patchComponentStateWithKnownHashes(
  cwd: string,
  updates: ComponentUpdate[],
  failedInstallRefs: string[]
) {
  const failedSet = new Set(failedInstallRefs);
  const state = loadRegistryState(cwd);
  const now = new Date().toISOString();

  for (const failedRef of failedSet) {
    const existing = state.components[failedRef];
    if (!existing) continue;
    state.components[failedRef] = {
      ...existing,
      status: "install_failed",
      lastCheckAt: now,
      lastError: "Component installation failed.",
    };
  }

  for (const update of updates) {
    if (failedSet.has(update.installRef)) continue;

    if (!isInstallRefPresentLocally(update.installRef, cwd)) {
      const existing = state.components[update.installRef];
      state.components[update.installRef] = {
        ...(existing ?? {
          installRef: update.installRef,
          sourceUrl: update.sourceUrl,
          hash: update.previousHash,
          updatedAt: now,
        }),
        status: "install_failed",
        lastCheckAt: now,
        lastError: "Component files were not found after update.",
      };
      continue;
    }

    state.components[update.installRef] = {
      installRef: update.installRef,
      sourceUrl: update.sourceUrl,
      hash: update.latestHash,
      updatedAt: now,
      status: "up_to_date",
      lastCheckAt: now,
      lastError: undefined,
    };
  }

  saveRegistryState(cwd, state);
}

export async function reconcileInstallStateBySource(
  cwd: string,
  attemptedSourceUrls: string[],
  failedSourceUrls: string[]
) {
  const attempted = new Set(attemptedSourceUrls);
  const failed = new Set(failedSourceUrls);
  const state = loadRegistryState(cwd);
  const now = new Date().toISOString();

  for (const [installRef, entry] of Object.entries(state.components)) {
    if (!attempted.has(entry.sourceUrl)) continue;

    if (failed.has(entry.sourceUrl)) {
      state.components[installRef] = {
        ...entry,
        status: "install_failed",
        lastCheckAt: now,
        lastError: "Component installation failed.",
      };
      continue;
    }

    if (!isInstallRefPresentLocally(installRef, cwd)) {
      state.components[installRef] = {
        ...entry,
        status: "install_failed",
        lastCheckAt: now,
        lastError: "Component files were not found after install.",
      };
      continue;
    }

    try {
      const hash = await fetchRemoteHash(entry.sourceUrl);
      state.components[installRef] = {
        ...entry,
        hash,
        updatedAt: now,
        status: "up_to_date",
        lastCheckAt: now,
        lastError: undefined,
      };
    } catch {
      // Keep previous hash when remote cannot be fetched now.
      state.components[installRef] = {
        ...entry,
        updatedAt: now,
        status: "up_to_date",
        lastCheckAt: now,
        lastError: undefined,
      };
    }
  }

  saveRegistryState(cwd, state);
}
