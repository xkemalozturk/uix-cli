export type DependencyList = {
  dependencies?: string[];
  devDependencies?: string[];
  peerDependencies?: string[];
};

export type RegistryItem = DependencyList & {
  name?: string;
  url?: string;
};

export type RegistryPayload = RegistryItem[] | { items: RegistryItem[] };
