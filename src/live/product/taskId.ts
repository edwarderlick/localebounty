import { isEoaAddress } from "../format";

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function sha256Utf8(text: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(text));
}

export function addressBytes(hex: string): Uint8Array {
  const trimmed = hex.trim();
  if (!isEoaAddress(trimmed)) {
    throw new Error(`Not a 20-byte address: ${hex}`);
  }
  const bytes = new Uint8Array(20);
  for (let i = 0; i < 20; i++) {
    bytes[i] = Number.parseInt(trimmed.slice(2 + i * 2, 4 + i * 2), 16);
  }
  return bytes;
}

/** Matches LocaleBounty._new_task_id: sha256(funder.as_bytes || contract.as_bytes || utf8(nonce)). */
export async function expectedTaskId(funder: string, contract: string, clientNonce: string): Promise<string> {
  const nonce = new TextEncoder().encode(clientNonce);
  const raw = new Uint8Array(40 + nonce.length);
  raw.set(addressBytes(funder), 0);
  raw.set(addressBytes(contract), 20);
  raw.set(nonce, 40);
  return sha256Hex(raw);
}

export function freshClientNonce(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
