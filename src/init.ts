import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { basename, join, resolve } from "path";
import ora from "ora";
import chalk from "chalk";
import * as p from "@clack/prompts";

const SRC_DIRS = ["src/components", "src/hooks", "src/lib", "src/styles"];
const BASE_DEPENDENCIES = {
  "class-variance-authority": "latest",
  clsx: "latest",
  "lucide-react": "latest",
  "tailwind-merge": "latest",
};
const BASE_DEV_DEPENDENCIES = {
  "@types/node": "latest",
  "@types/react": "latest",
  "@types/react-dom": "latest",
  autoprefixer: "latest",
  postcss: "latest",
  "tailwindcss-animate": "latest",
  typescript: "latest",
};

function getPackageJson(name: string, aliasPrefix: string) {
  return {
    name: aliasPrefix === "@" ? name : aliasPrefix,
    version: "0.0.0",
    private: true,
    exports: {
      "./globals.css": "./src/styles/globals.css",
      "./postcss.config": "./postcss.config.mjs",
      "./lib/*": "./src/lib/*.ts",
      "./components/*": "./src/components/*.tsx",
      "./hooks/*": "./src/hooks/*.ts",
      "./*": "./src/*",
    },
    dependencies: BASE_DEPENDENCIES,
    devDependencies: BASE_DEV_DEPENDENCIES,
    peerDependencies: {
      "@types/node": "latest",
      "@types/react": "latest",
      "@types/react-dom": "latest",
      react: "latest",
      "react-dom": "latest",
      tailwindcss: "latest",
      typescript: "latest",
    },
  };
}

function getComponentsConfig(aliasPrefix: string) {
  return {
    $schema: "https://ui.shadcn.com/schema.json",
    style: "new-york",
    rsc: false,
    tsx: true,
    tailwind: {
      config: "",
      css: "src/styles/globals.css",
      baseColor: "zinc",
      cssVariables: true,
      prefix: "",
    },
    aliases: {
      components: `${aliasPrefix}/components`,
      utils: `${aliasPrefix}/lib/utils`,
      ui: `${aliasPrefix}/components`,
      lib: `${aliasPrefix}/lib`,
      hooks: `${aliasPrefix}/hooks`,
    },
    iconLibrary: "lucide",
  };
}

function normalizePackageName(name: string, dir: string) {
  const trimmed = name.trim().replace(/\/+$/, "");
  if (!trimmed) return name;

  // Normalize invalid scoped names like "@workspace" to "@workspace/<folder>".
  if (/^@[^/]+$/.test(trimmed)) {
    const folderName = basename(dir).trim();
    if (folderName) return `${trimmed}/${folderName}`;
  }

  return trimmed;
}

export async function initPackage(name: string, dir: string) {
  const targetDir = resolve(process.cwd(), dir);
  const packageName = normalizePackageName(name, dir);
  const aliasPrefix = packageName;

  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
    p.log.success(`Created directory ${dir}`);
  }

  const pkgPath = join(targetDir, "package.json");
  if (!existsSync(pkgPath)) {
    const pkg = getPackageJson(packageName, aliasPrefix);
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
    p.log.success(`Created package.json for ${packageName}`);
  }

  mergeDependencies(pkgPath, BASE_DEPENDENCIES, BASE_DEV_DEPENDENCIES);

  const files = {
    "components.json": JSON.stringify(getComponentsConfig(aliasPrefix), null, 2),
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        target: "es2022",
        lib: ["dom", "dom.iterable", "esnext"],
        allowJs: true,
        skipLibCheck: true,
        strict: true,
        noEmit: true,
        esModuleInterop: true,
        module: "esnext",
        moduleResolution: "node",
        resolveJsonModule: true,
        isolatedModules: true,
        jsx: "preserve",
        incremental: true,
        paths: {
          [`${packageName}/*`]: ["./src/*"],
        },
      },
      include: ["."],
      exclude: ["node_modules", "dist"],
    }, null, 2),

    "src/styles/globals.css": `@import "tailwindcss";

@theme {
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --color-background: var(--background);
  --color-foreground: var(--foreground);

  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);

  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);

  --color-destructive: var(--destructive);
  --color-destructive-foreground: var(--destructive-foreground);

  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);

  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);

  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);

  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);

  --radius-lg: var(--radius);
  --radius-md: calc(var(--radius) - 2px);
  --radius-sm: calc(var(--radius) - 4px);

  --animate-accordion-down: accordion-down 0.2s ease-out;
  --animate-accordion-up: accordion-up 0.2s ease-out;

  @keyframes accordion-down {
    from { height: 0; }
    to { height: var(--radix-accordion-content-height); }
  }
  @keyframes accordion-up {
    from { height: var(--radix-accordion-content-height); }
    to { height: 0; }
  }
}

@layer base {
  :root {
    --background: hsl(0 0% 100%);
    --foreground: hsl(240 10% 3.9%);
    --card: hsl(0 0% 100%);
    --card-foreground: hsl(240 10% 3.9%);
    --popover: hsl(0 0% 100%);
    --popover-foreground: hsl(240 10% 3.9%);
    --primary: hsl(240 5.9% 10%);
    --primary-foreground: hsl(0 0% 98%);
    --secondary: hsl(240 4.8% 95.9%);
    --secondary-foreground: hsl(240 5.9% 10%);
    --muted: hsl(240 4.8% 95.9%);
    --muted-foreground: hsl(240 3.8% 46.1%);
    --accent: hsl(240 4.8% 95.9%);
    --accent-foreground: hsl(240 5.9% 10%);
    --destructive: hsl(0 84.2% 60.2%);
    --destructive-foreground: hsl(0 0% 98%);
    --border: hsl(240 5.9% 90%);
    --input: hsl(240 5.9% 90%);
    --ring: hsl(240 10% 3.9%);
    --radius: 0.5rem;
  }

  .dark {
    --background: hsl(240 10% 3.9%);
    --foreground: hsl(0 0% 98%);
    --card: hsl(240 10% 3.9%);
    --card-foreground: hsl(0 0% 98%);
    --popover: hsl(240 10% 3.9%);
    --popover-foreground: hsl(0 0% 98%);
    --primary: hsl(0 0% 98%);
    --primary-foreground: hsl(240 5.9% 10%);
    --secondary: hsl(240 3.7% 15.9%);
    --secondary-foreground: hsl(0 0% 98%);
    --muted: hsl(240 3.7% 15.9%);
    --muted-foreground: hsl(240 5% 64.9%);
    --accent: hsl(240 3.7% 15.9%);
    --accent-foreground: hsl(0 0% 98%);
    --destructive: hsl(0 62.8% 30.6%);
    --destructive-foreground: hsl(0 0% 98%);
    --border: hsl(240 3.7% 15.9%);
    --input: hsl(240 3.7% 15.9%);
    --ring: hsl(240 4.9% 83.9%);
  }
}

@layer base {
  * {
    @apply border-border outline-ring/50;
  }
  body {
    @apply bg-background text-foreground;
  }
}
`,
    "src/lib/utils.ts": `import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
`
  };

  const spinner = ora(chalk.cyan("Initializing environment...")).start();
  try {
    for (const d of SRC_DIRS) {
      const dirPath = resolve(targetDir, d);
      if (!existsSync(dirPath)) mkdirSync(dirPath, { recursive: true });
    }

    for (const [file, content] of Object.entries(files)) {
      const fullPath = join(targetDir, file);
      const dirPath = resolve(fullPath, "..");
      if (!existsSync(dirPath)) mkdirSync(dirPath, { recursive: true });
      if (!existsSync(fullPath)) writeFileSync(fullPath, content);
    }
    spinner.succeed("Environment initialized");
  } catch (err) {
    spinner.fail("Failed to initialize environment");
    console.error(err);
    process.exit(1);
  }

}

function mergeDependencies(
  pkgPath: string,
  dependencies: Record<string, string>,
  devDependencies: Record<string, string>
) {
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

  pkg.dependencies = {
    ...(pkg.dependencies ?? {}),
    ...dependencies,
  };

  pkg.devDependencies = {
    ...(pkg.devDependencies ?? {}),
    ...devDependencies,
  };

  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
}
