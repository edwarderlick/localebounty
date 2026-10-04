import { formatError } from "../format";
import { createReadClient, readProductView } from "../genlayer";
import { asCount } from "../productUi/parse";
import { PRODUCT_UI_V2_CONTRACT } from "./constants";
import { clampListLimit, clampListOffset, parseV2TaskSummaryList, type V2TaskSummary } from "./summary";

export async function readV2TaskCount(address = PRODUCT_UI_V2_CONTRACT): Promise<number> {
  const raw = await readProductView(createReadClient(), address, "task_count", []);
  const count = asCount(raw);
  if (count == null) {
    throw new Error(`task_count returned an unreadable value: ${formatError(raw)}`);
  }
  return count;
}

export async function readV2TaskPage(
  offset: number,
  limit: number,
  address = PRODUCT_UI_V2_CONTRACT,
): Promise<V2TaskSummary[]> {
  const safeLimit = clampListLimit(limit);
  const safeOffset = Math.max(0, Math.trunc(offset));
  const raw = await readProductView(createReadClient(), address, "list_tasks", [safeOffset, safeLimit]);
  return parseV2TaskSummaryList(raw);
}

export async function loadV2BoardPage(input: {
  offset: number;
  limit: number;
  address?: string;
}): Promise<{ count: number; offset: number; limit: number; items: V2TaskSummary[] }> {
  const address = input.address ?? PRODUCT_UI_V2_CONTRACT;
  const count = await readV2TaskCount(address);
  const limit = clampListLimit(input.limit);
  const offset = clampListOffset(input.offset, count);
  const items = count === 0 ? [] : await readV2TaskPage(offset, limit, address);
  return { count, offset, limit, items };
}
