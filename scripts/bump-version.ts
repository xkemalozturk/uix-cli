/**
 * Auto-versioning script
 * Format: vYYYY.MM.DD.patch
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const pkgPath = join(import.meta.dir, "..", "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

const now = new Date();
const year = now.getFullYear();
const month = String(now.getMonth() + 1).padStart(2, "0");
const day = String(now.getDate()).padStart(2, "0");
const todayPrefix = `${year}.${month}.${day}`;

const currentVersion: string = pkg.version ?? "0.0.0";

let patch = 0;

if (currentVersion.startsWith(todayPrefix + ".")) {
  const currentPatch = parseInt(currentVersion.split(".").pop() ?? "0", 10);
  patch = currentPatch + 1;
}

const newVersion = `${todayPrefix}.${patch}`;
pkg.version = newVersion;

writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

console.log(`✅ Version bumped: ${currentVersion} → ${newVersion}`);
