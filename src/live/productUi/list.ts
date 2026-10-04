import { formatError } from "../format";
import { createReadClient, readProductView } from "../genlayer";
import { PRODUCT_UI_CONTRACT } from "./constants";
import { asCount } from "./parse";
import {
  clampListLimit,
  clampListOffset,
  parseTaskSummaryList,
  type LiveTaskSummary,
} from "./summary";

export type BoardPage = {
  count: number;
  offset: number;
  limit: number;
  items: LiveTaskSummary[];
};

export async function readTaskCount(address = PRODUCT_UI_CONTRACT): Promise<number> {
  const raw = await readProductView(createReadClient(), address, "task_count", []);
  const count = asCount(raw);
  if (count == null) {
    throw new Error(`task_count returned an unreadable value: ${formatError(raw)}`);
  }
  return count;
}

export async function readTaskPage(
  offset: number,
  limit: number,
  address = PRODUCT_UI_CONTRACT,
): Promise<LiveTaskSummary[]> {
  const safeLimit = clampListLimit(limit);
  const safeOffset = Math.max(0, Math.trunc(offset));
  const raw = await readProductView(createReadClient(), address, "list_tasks", [safeOffset, safeLimit]);
  return parseTaskSummaryList(raw);
}

export async function loadBoardPage(input: {
  offset: number;
  limit: number;
  address?: string;
}): Promise<BoardPage> {
  const address = input.address ?? PRODUCT_UI_CONTRACT;
  const count = await readTaskCount(address);
  const limit = clampListLimit(input.limit);
  const offset = clampListOffset(input.offset, count);
  const items = count === 0 ? [] : await readTaskPage(offset, limit, address);
  return { count, offset, limit, items };
}
