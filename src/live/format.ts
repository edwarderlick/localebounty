import { isRecord } from "./eip1193";
import { LOCK_WEI, ZERO_ADDRESS } from "./network";
import { classifyDeadlineUserError } from "./product/clock";

export function isEoaAddress(value: string): value is `0x${string}` {
  return /^0x[0-9a-fA-F]{40}$/.test(value.trim());
}

export function isZeroAddress(value: string): boolean {
  return value.trim().toLowerCase() === ZERO_ADDRESS;
}

export function addressesEqual(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export const WEI_PER_GEN = 10n ** 18n;
/** Historical Studio-dev probe payout-write `primary_fee_spent`. 1 GEN = 10^18 wei. */
export const PROBE_PAYOUT_ACTUAL_FEE_WEI = 126304500000823n;
/** Phase B1 live evaluate_task `primary_fee_spent`. */
export const B1_EVALUATE_ACTUAL_FEE_WEI = 126529000000823n;

export const FEE_DEPOSIT_LABEL = "Fee deposit (quote, required upfront)";
export const ACTUAL_FEE_CONSUMED_LABEL = "Actual fee consumed (receipt)";
export const UNUSED_FEE_DEPOSIT_LABEL = "Unused fee deposit returned";

export function weiToGen(wei: bigint): string {
  const negative = wei < 0n;
  const abs = negative ? -wei : wei;
  const whole = abs / WEI_PER_GEN;
  const frac = abs % WEI_PER_GEN;
  const fracStr = frac.toString().padStart(18, "0").replace(/0+$/, "");
  const body = fracStr.length ? `${whole.toString()}.${fracStr}` : whole.toString();
  return `${negative ? "-" : ""}${body}`;
}

export function formatGen(wei: bigint): string {
  return `${weiToGen(wei)} GEN`;
}

export function parseWeiString(value?: string | null): bigint | null {
  if (value == null || value === "") return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

export type FeeDepositFigures = {
  depositWei: bigint | null;
  actualWei: bigint | null;
  unusedWei: bigint | null;
  depositLabel: string;
  actualLabel: string;
  unusedLabel: string;
};

/** Quote is a deposit required upfront. Receipt `primary_fee_spent` is actual consumption. Unused deposit is returned. */
export function feeDepositFigures(quotedFeeWei?: string | null, actualFeeWei?: string | null): FeeDepositFigures {
  const depositWei = parseWeiString(quotedFeeWei);
  const actualWei = parseWeiString(actualFeeWei);
  const unusedWei =
    depositWei != null && actualWei != null && depositWei >= actualWei ? depositWei - actualWei : null;
  return {
    depositWei,
    actualWei,
    unusedWei,
    depositLabel:
      depositWei == null
        ? `${FEE_DEPOSIT_LABEL}: not quoted yet.`
        : `${FEE_DEPOSIT_LABEL}: ${formatGen(depositWei)} (${depositWei.toString()} wei).`,
    actualLabel:
      actualWei == null
        ? `${ACTUAL_FEE_CONSUMED_LABEL}: unread.`
        : `${ACTUAL_FEE_CONSUMED_LABEL}: ${formatGen(actualWei)} (${actualWei.toString()} wei).`,
    unusedLabel:
      unusedWei == null
        ? `${UNUSED_FEE_DEPOSIT_LABEL}: unread.`
        : `${UNUSED_FEE_DEPOSIT_LABEL}: ${formatGen(unusedWei)} (${unusedWei.toString()} wei).`,
  };
}

export function formatWei(wei: bigint): string {
  return `${wei.toString()} wei`;
}

export function lockLabel(): string {
  return `${weiToGen(LOCK_WEI)} GEN (${LOCK_WEI.toString()} wei)`;
}

export function explorerAddress(address: string): string {
  return `https://explorer-studio-dev.genlayer.com/address/${address}`;
}

export function explorerTx(txId: string): string {
  return `https://explorer-studio-dev.genlayer.com/tx/${txId}`;
}

const SKIP_WALK_KEYS = /private|secret|node_config|private_key/i;
const PREFERRED_WALK_KEYS = [
  "result",
  "receipt",
  "execution_result",
  "error_description",
  "stderr",
  "data",
  "cause",
  "details",
  "message",
];

function stripControlPrefix(text: string): string {
  return text.replace(/^[\u0000-\u0008\u000b\u000c\u000e-\u001f]+/, "").trim();
}

function looksLikeUserError(text: string): boolean {
  return /deadline|rejected|required|reused|unauthorized|unknown task|invalid page|already |not open|collision|zero value|named translator|named wallet|transfer submission/i.test(
    text,
  );
}

function decodeBytesUtf8(bytes: Uint8Array): string | undefined {
  let start = 0;
  if (bytes.length > 1 && (bytes[0] === 1 || bytes[0] === 2)) start = 1;
  const text = stripControlPrefix(new TextDecoder().decode(bytes.slice(start)));
  return text || undefined;
}

function decodeHexUtf8(raw: string): string | undefined {
  let hex = raw.trim();
  if (hex.startsWith("0x") || hex.startsWith("0X")) hex = hex.slice(2);
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length < 8 || hex.length % 2 !== 0) return undefined;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return decodeBytesUtf8(bytes);
}

function decodeBase64Utf8(raw: string): string | undefined {
  try {
    const normalized = raw.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    return decodeBytesUtf8(bytes);
  } catch {
    return undefined;
  }
}

function decodePayloadString(raw: string): string | undefined {
  const hex = decodeHexUtf8(raw);
  if (hex && looksLikeUserError(hex)) return hex;
  if (/^[A-Za-z0-9+/_-]+=*$/.test(raw) && raw.length >= 8) {
    const decoded = decodeBase64Utf8(raw);
    if (decoded && looksLikeUserError(decoded)) return decoded;
  }
  const stripped = stripControlPrefix(raw);
  if (stripped && looksLikeUserError(stripped)) return stripped;
  return hex ?? stripped ?? undefined;
}

function collectCandidateStrings(value: unknown, depth: number, keyHint: string, out: string[]): void {
  if (depth > 10 || value == null) return;
  if (SKIP_WALK_KEYS.test(keyHint)) return;
  if (typeof value === "string") {
    if (value.length >= 4) out.push(value);
    return;
  }
  if (value instanceof Uint8Array) {
    const decoded = decodeBytesUtf8(value);
    if (decoded) out.push(decoded);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 0 && value.every((item) => typeof item === "number")) {
      const decoded = decodeBytesUtf8(Uint8Array.from(value));
      if (decoded) out.push(decoded);
      return;
    }
    for (const item of value) collectCandidateStrings(item, depth + 1, keyHint, out);
    return;
  }
  if (!isRecord(value)) return;
  const keys = [
    ...PREFERRED_WALK_KEYS.filter((key) => key in value),
    ...Object.keys(value).filter((key) => !PREFERRED_WALK_KEYS.includes(key)),
  ];
  for (const key of keys) collectCandidateStrings(value[key], depth + 1, key, out);
}

/** Studio-dev maps contract UserError to JSON-RPC "execution failed". Decode the receipt payload. */
export function decodeStudioUserError(error: unknown): string | undefined {
  const candidates: string[] = [];
  collectCandidateStrings(error, 0, "", candidates);
  for (const raw of candidates) {
    const decoded = decodePayloadString(raw);
    if (decoded && looksLikeUserError(decoded) && !/Missing or invalid parameters/i.test(decoded)) {
      return decoded;
    }
  }
  return undefined;
}

export function formatError(error: unknown): string {
  if (error == null) return "unknown error";
  const userError = decodeStudioUserError(error);
  if (userError) {
    const status = classifyDeadlineUserError(userError);
    if (status === "far" || status === "past" || status === "early") {
      return `Studio-dev contract rejected the call: ${userError}. Create deadlines follow Studio-dev GetTimestamp, which can lag the browser clock. Estimate again to bind a fresh window.`;
    }
    return `Studio-dev contract rejected the call: ${userError}`;
  }
  if (typeof error === "string") return error;
  if (typeof error === "object") {
    const record = error as {
      message?: unknown;
      shortMessage?: unknown;
      details?: unknown;
      code?: unknown;
      data?: unknown;
    };
    const nested =
      record.data && typeof record.data === "object"
        ? (record.data as { message?: unknown }).message
        : undefined;
    const parts = [record.shortMessage, record.message, nested, record.details]
      .map((part) => (typeof part === "string" ? part : null))
      .filter((part): part is string => Boolean(part));
    if (parts.length) {
      const text = parts[0];
      if (/Missing or invalid parameters/i.test(text)) {
        const details = parts.slice(1).join(" ");
        if (/execution failed/i.test(`${text} ${details}`)) {
          return `${text} Studio-dev execution failed. This is often a contract deadline or value check. GenVM Address encoding is only one possible cause.`;
        }
        return `${text} GenVM Address arguments must be 20-byte Address values, not hex strings.`;
      }
      return text;
    }
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

function bigintReplacer(_key: string, inner: unknown): unknown {
  if (typeof inner === "bigint") return inner.toString();
  return inner;
}

/** Convert values (including nested bigint from genlayer-js) into JSON-round-trippable data. */
export function jsonSafe(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value, bigintReplacer));
  } catch {
    return { jsonSafeError: "Value could not be serialized" };
  }
}

/** JSON.stringify that never throws on bigint. Used for persist and Copy evidence. */
export function jsonStringifySafe(value: unknown, space?: number): string {
  try {
    return JSON.stringify(value, bigintReplacer, space);
  } catch (err) {
    return JSON.stringify({ error: formatError(err) }, null, space);
  }
}
