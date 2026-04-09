import pLimit from "p-limit";
import ora from "ora";
import chalk from "chalk";
import { isInstalled } from "./utils";
import type { RegistryItem } from "./types";

const limit = pLimit(1);
const URL_CHECK_TIMEOUT_MS = 15_000;

function formatEta(ms: number) {
  if (ms < 1000) return "<1s";
  const s = Math.ceil(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

async function urlExists(url: string): Promise<boolean> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), URL_CHECK_TIMEOUT_MS);

  try {
    let res = await fetch(url, {
      method: "HEAD",
      signal: controller.signal,
    });
    if (res.status === 405 || res.status === 501) {
      res = await fetch(url, {
        method: "GET",
        signal: controller.signal,
      });
    }

    clearTimeout(id);
    return res.status < 400;
  } catch {
    clearTimeout(id);
    return false;
  }
}

export function buildCandidateUrls(item: RegistryItem, pattern: string): string[] {
  if (!item.name) return [];
  if (item.url) return [item.url];

  const url = pattern.replace("{name}", item.name);
  return url.endsWith(".json") ? [url] : [`${url}.json`, url];
}

export async function resolveItemSourceUrl(item: RegistryItem, pattern: string): Promise<string | null> {
  for (const candidate of buildCandidateUrls(item, pattern)) {
    if (await urlExists(candidate)) return candidate;
  }
  return null;
}

export async function buildInstallList(
  items: RegistryItem[],
  pattern: string,
  cwd: string,
  diff: boolean,
  registryName?: string | null
) {
  if (registryName) {
    const selected = items
      .filter((item): item is RegistryItem & { name: string } => Boolean(item.name))
      .filter((item) => !(diff && isInstalled(item.name, cwd)))
      .map((item) => `${registryName}/${item.name}`);
    return selected;
  }

  const total = items.length;
  let checked = 0;
  let found = 0;

  const spinner = ora(chalk.cyan("Scanning registry...")).start();
  const start = Date.now();

  const tasks = items.map((item) =>
    limit(async () => {
      if (!item.name) {
        checked++;
        return null;
      }

      if (diff && isInstalled(item.name, cwd)) {
        checked++;
        return null;
      }

      const updateProgress = () => {
        const pct = Math.round((checked / total) * 100);
        const elapsed = Date.now() - start;
        const avg = checked > 0 ? elapsed / checked : 0;
        const remaining = avg * (total - checked);
        const eta = checked > 0 ? formatEta(remaining) : "calculating...";

        spinner.text = `${chalk.cyan(`Scanning ${item.name}`)} ${chalk.gray(
          `[${checked}/${total}] ${pct}% • Found ${found} • ETA ${eta}`
        )}`;
      };

      for (const candidate of buildCandidateUrls(item, pattern)) {
        if (await urlExists(candidate)) {
          checked++;
          found++;
          updateProgress();
          // Return scoped name if registryName is provided, otherwise return URL
          return registryName ? `${registryName}/${item.name}` : candidate;
        }
      }

      checked++;
      updateProgress();
      return null;
    })
  );

  const res = (await Promise.all(tasks)).filter(Boolean);

  const time = ((Date.now() - start) / 1000).toFixed(2);
  spinner.succeed(
    `Scanned ${total} items in ${time}s — ${chalk.green(`${found} available`)}`
  );
  return res as string[];
}
