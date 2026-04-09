const FALLBACK_ALIASES: Record<string, string> = {
  shadcn: "https://ui.shadcn.com/r/registry.json",
  tablecn: "https://raw.githubusercontent.com/sadmann7/tablecn/refs/heads/main/public/r/registry.json",
  "coss-origin": "https://raw.githubusercontent.com/cosscom/coss/refs/heads/main/apps/origin/registry.json",
};

const FALLBACK_PATTERNS: Record<string, string> = {
  shadcn: "https://ui.shadcn.com/r/{name}.json",
  tablecn: "https://raw.githubusercontent.com/sadmann7/tablecn/refs/heads/main/public/r/{name}.json",
  "coss-origin": "https://coss.com/origin/r/{name}.json",
};

// Stores original URL patterns (with {style}/{name} placeholders) from directory.json
const ORIGINAL_PATTERNS: Record<string, string> = {};

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export async function fetchRegistryAliases(): Promise<Record<string, string>> {
  const map: Record<string, string> = { ...FALLBACK_ALIASES };
  for (const [name, pattern] of Object.entries(FALLBACK_PATTERNS)) {
    ORIGINAL_PATTERNS[name] = pattern;
  }

  try {
    const res = await fetch("https://raw.githubusercontent.com/shadcn-ui/ui/refs/heads/main/apps/v4/registry/directory.json");
    if (!res.ok) throw new Error("Failed to fetch registry directory");
    
    const data = await res.json() as Array<{ name?: string; url?: string }>;
    for (const item of data) {
      if (item.name && item.url) {
         const cleanName = item.name.startsWith("@") ? item.name.slice(1) : item.name;
         // Store original pattern for per-component URL construction
         ORIGINAL_PATTERNS[cleanName] = item.url;
         let url = item.url;
         // Remove {style}/ segment — registries with {style} don't serve registry.json
         url = url.replace("{style}/", "");
         url = url.replace("{name}.json", "registry.json");
         url = url.replace("{name}", "registry");
         map[cleanName] = url;
      }
    }
  } catch {
    // Keep fallback aliases when remote lookup fails.
  }
  
  return map;
}

/**
 * Get the original URL pattern (with placeholders) for a registry alias.
 */
export function getRegistryPattern(alias: string): string | null {
  const cleanAlias = alias.startsWith("@") ? alias.slice(1) : alias;
  return ORIGINAL_PATTERNS[cleanAlias] || null;
}

/**
 * Check if a registry alias has a {style} parameter in its URL.
 */
export function hasStyleParam(alias: string): boolean {
  const pattern = getRegistryPattern(alias);
  return pattern ? pattern.includes("{style}") : false;
}

/**
 * Fetch available styles for a registry that uses {style}.
 * Derives the styles URL from the original pattern's base URL + /styles/.
 */
export async function fetchRegistryStyles(alias: string): Promise<Array<{ name: string; label: string }>> {
  const pattern = getRegistryPattern(alias);
  if (!pattern) return [];

  // Extract base URL (everything before /r/)
  const match = pattern.match(/^(https?:\/\/[^/]+)\/r\//);
  if (!match) return [];

  const stylesUrl = `${match[1]}/r/styles/`;
  try {
    const res = await fetch(stylesUrl);
    if (!res.ok) return [];
    return await res.json() as Array<{ name: string; label: string }>;
  } catch {
    return [];
  }
}

export async function resolveRegistryUrl(input: string): Promise<string> {
  // If it's already a full URL
  if (input.startsWith("http://") || input.startsWith("https://")) {
    return input;
  }

  // Remove '@' prefix if present (e.g. '@aceternity')
  const cleanInput = input.startsWith("@") ? input.slice(1) : input;

  const aliases = await fetchRegistryAliases();

  // Check aliases
  if (aliases[cleanInput]) {
    return aliases[cleanInput];
  }

  // If it looks like a domain (contains a dot), fallback to standard registry path
  if (cleanInput.includes(".")) {
    return `https://${cleanInput}/r/registry.json`;
  }

  throw new Error(
    `Unknown registry alias: "${input}".\nPlease provide a full URL or a valid domain (e.g., ui.aceternity.com).`
  );
}

/**
 * Resolve the scoped registry name from input.
 * e.g. "diceui" → "@diceui", "@diceui" → "@diceui",
 *      "https://diceui.com/r/registry.json" → null (can't infer from URL alone)
 */
export async function resolveRegistryName(input: string): Promise<string | null> {
  // Full URL — try to match against known registries
  if (input.startsWith("http://") || input.startsWith("https://")) {
    const aliases = await fetchRegistryAliases();
    const normalizedInput = normalizeUrl(input);

    // Reverse-map exact known registry URLs to alias names.
    for (const [name, url] of Object.entries(aliases)) {
      if (normalizeUrl(url) === normalizedInput) {
        return `@${name}`;
      }
    }

    return null;
  }

  // Already has @
  if (input.startsWith("@")) {
    return input;
  }

  // Plain alias like "diceui"
  return `@${input}`;
}
