import { existsSync } from "fs";
import { join } from "path";

export function isInstalled(name: string, cwd: string) {
  const paths = [
    join(cwd, "components", `${name}.tsx`),
    join(cwd, "components", `${name}.ts`),
    join(cwd, "components", "ui", `${name}.tsx`),
    join(cwd, "components", "ui", `${name}.ts`),
    join(cwd, "src/components", `${name}.tsx`),
    join(cwd, "src/components", `${name}.ts`),
    join(cwd, "src/components", "ui", `${name}.tsx`),
    join(cwd, "src/components", "ui", `${name}.ts`),
    join(cwd, "src/lib", `${name}.ts`),
    join(cwd, "src/lib", `${name}.tsx`),
    join(cwd, "src/hooks", `${name}.ts`),
    join(cwd, "src/hooks", `${name}.tsx`),
    join(cwd, "components", name, "index.tsx"),
    join(cwd, "components", name, "index.ts"),
    join(cwd, "components", "ui", name, "index.tsx"),
    join(cwd, "components", "ui", name, "index.ts"),
    join(cwd, "src/components", name, "index.tsx"),
    join(cwd, "src/components", name, "index.ts"),
    join(cwd, "src/components", "ui", name, "index.tsx"),
    join(cwd, "src/components", "ui", name, "index.ts"),
  ];

  return paths.some((p) => existsSync(p));
}
