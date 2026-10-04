import { formatError, jsonSafe } from "../format";
import { createReadClient, readProductTask } from "../genlayer";
import { parseProductTask, type ProductTask } from "../product/task";
import { PRODUCT_UI_CONTRACT } from "./constants";
import { loadProductUiSession, rememberOpenedTask, saveProductUiSession } from "./persist";

export async function loadLiveProductTask(taskId: string): Promise<ProductTask> {
  const raw = jsonSafe(await readProductTask(createReadClient(), PRODUCT_UI_CONTRACT, taskId));
  const task = parseProductTask(raw);
  if (!task) {
    throw new Error(`get_task did not return a parseable task for ${taskId}.`);
  }
  saveProductUiSession(rememberOpenedTask(loadProductUiSession(), task.task_id));
  return task;
}

export function taskLoadError(err: unknown): string {
  return formatError(err);
}
