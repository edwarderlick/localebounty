function makeAddress(head: string, tail: string): string {
  const h = head.replace(/^0x/i, "");
  const t = tail;
  const pad = 40 - h.length - t.length;
  if (pad < 0) {
    throw new Error("demo address overflow");
  }
  return `0x${h}${"0".repeat(pad)}${t}`;
}

export const DEMO_OWNER = {
  role: "owner" as const,
  address: makeAddress("71C", "4f9A"),
  short: "0x71C...4f9A",
  name: "Demo Owner",
};

export const DEMO_TRANSLATOR = {
  role: "translator" as const,
  address: makeAddress("94b3A8187F63d294821aF7556019Cd2bE0C28a1", ""),
  short: "0x94b...28a1",
  name: "Elena Vasquez",
  ens: "elena.eth",
};

export const DEMO_KENJI = {
  address: makeAddress("38F", "b5C1"),
  short: "0x38F...b5C1",
  name: "Kenji",
  ens: "kenji.eth",
};

export const DEMO_HANS = {
  address: makeAddress("72A", "9F21"),
  short: "0x72A...9F21",
  name: "Hans",
  ens: "hans.eth",
};

export const DEMO_THIAGO = {
  address: makeAddress("41E", "198C"),
  short: "0x41E...198C",
  name: "Thiago",
  ens: "thiago.eth",
};

const ALIASES: Record<string, string> = {
  "0x94b3a8187f63d294821af7556019cd2be0c28a1": DEMO_TRANSLATOR.address,
  "elena.eth": DEMO_TRANSLATOR.address,
  "elena_translations.eth": DEMO_TRANSLATOR.address,
};

const DIRECTORY: Record<string, { name: string; ens?: string; short: string }> = {
  [DEMO_OWNER.address.toLowerCase()]: { name: DEMO_OWNER.name, short: DEMO_OWNER.short },
  [DEMO_TRANSLATOR.address.toLowerCase()]: {
    name: DEMO_TRANSLATOR.name,
    ens: DEMO_TRANSLATOR.ens,
    short: DEMO_TRANSLATOR.short,
  },
  [DEMO_KENJI.address.toLowerCase()]: { name: DEMO_KENJI.name, ens: DEMO_KENJI.ens, short: DEMO_KENJI.short },
  [DEMO_HANS.address.toLowerCase()]: { name: DEMO_HANS.name, ens: DEMO_HANS.ens, short: DEMO_HANS.short },
  [DEMO_THIAGO.address.toLowerCase()]: { name: DEMO_THIAGO.name, ens: DEMO_THIAGO.ens, short: DEMO_THIAGO.short },
};

export function normalizeAddress(input: string): string {
  const trimmed = input.trim();
  const alias = ALIASES[trimmed.toLowerCase()];
  if (alias) return alias;
  return trimmed;
}

export function isHexAddress(value: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(normalizeAddress(value));
}

export function addressesEqual(a: string, b: string): boolean {
  return normalizeAddress(a).toLowerCase() === normalizeAddress(b).toLowerCase();
}

export function shortenAddress(address: string): string {
  const info = DIRECTORY[normalizeAddress(address).toLowerCase()];
  if (info) return info.short;
  const value = normalizeAddress(address);
  if (value.length < 10) return value;
  return `${value.slice(0, 5)}...${value.slice(-4)}`;
}

export function lookupIdentity(address: string): { name: string; ens?: string; short: string } | null {
  return DIRECTORY[normalizeAddress(address).toLowerCase()] ?? null;
}

export function formatActor(address: string, fallbackLabel?: string): string {
  const info = lookupIdentity(address);
  if (info?.ens) return `${info.short} (${info.ens})`;
  if (info) return `${info.short} (${info.name})`;
  if (fallbackLabel) return `${shortenAddress(address)} (${fallbackLabel})`;
  return shortenAddress(address);
}

export function currentActor(role: "owner" | "translator") {
  return role === "owner" ? DEMO_OWNER : DEMO_TRANSLATOR;
}
