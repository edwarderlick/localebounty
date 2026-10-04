/**
 * Demo-only in-browser store.
 *
 * This module is the UI/data boundary. A later Studio-dev adapter can
 * replace load/save/create/submit/simulate with real reads and writes.
 * There is no backend, wallet, contract, or GenLayer SDK here.
 */
import {
  addressesEqual,
  currentActor,
  DEMO_TRANSLATOR,
  isHexAddress,
  lookupIdentity,
  normalizeAddress,
} from "../lib/addresses";
import { generateId, nowIso } from "../lib/ids";
import { slugFromText } from "../lib/status";
import type { CreateTaskInput, DemoState, LibraryEntry, Role, Task } from "../types";
import { INITIAL_STATE } from "./seed";

export const STORAGE_KEY = "localebounty.demo.v1";

const ACCENTS: Task["accent"][] = ["orange", "lime", "cyan", "sand", "pink"];

export function loadState(): DemoState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(INITIAL_STATE);
    const parsed = JSON.parse(raw) as DemoState;
    if (!parsed || !Array.isArray(parsed.tasks) || !Array.isArray(parsed.library)) {
      return structuredClone(INITIAL_STATE);
    }
    return {
      role: parsed.role === "translator" ? "translator" : "owner",
      tasks: parsed.tasks,
      library: parsed.library,
      lastTaskId: parsed.lastTaskId ?? parsed.tasks[0]?.id ?? null,
    };
  } catch {
    return structuredClone(INITIAL_STATE);
  }
}

export function saveState(state: DemoState): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function pickAccent(tasks: Task[]): Task["accent"] {
  return ACCENTS[tasks.length % ACCENTS.length] ?? "orange";
}

export function setRole(state: DemoState, role: Role): DemoState {
  return { ...state, role };
}

export function touchTask(state: DemoState, taskId: string): DemoState {
  return { ...state, lastTaskId: taskId };
}

export function createTask(state: DemoState, input: CreateTaskInput): { state: DemoState; task: Task } {
  const actor = currentActor(state.role);
  const translatorAddress = normalizeAddress(input.translatorAddress);
  const identity = lookupIdentity(translatorAddress);
  const sourceText = input.sourceText.trim();
  const task: Task = {
    id: generateId("task"),
    title: input.title?.trim() || sourceText.slice(0, 48) || "Untitled string",
    stringKey: `${slugFromText(input.context || sourceText)}.${slugFromText(sourceText)}`,
    module: input.module?.trim() || "Checkout & Fulfillment",
    sourceLanguage: "EN-US",
    targetLanguage: input.targetLanguage,
    sourceText,
    context: input.context.trim(),
    meaning: input.meaning.trim(),
    requirements: input.requirements.map((r) => r.trim()).filter(Boolean),
    translatorAddress,
    translatorLabel: identity?.name ?? "Named translator",
    ownerAddress: actor.address,
    intendedRewardGen: input.intendedRewardGen,
    status: "open",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    accent: pickAccent(state.tasks),
    submission: null,
    decision: null,
  };
  const next = { ...state, tasks: [task, ...state.tasks], lastTaskId: task.id };
  return { state: next, task };
}

export function submitTranslation(
  state: DemoState,
  taskId: string,
  text: string,
  notes: string,
): { state: DemoState; error?: string } {
  const actor = currentActor(state.role);
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task) return { state, error: "Task not found." };
  if (!addressesEqual(actor.address, task.translatorAddress)) {
    return { state, error: "Only the named translator can submit for this task." };
  }
  if (task.status === "approved") {
    return { state, error: "This demo task is already approved." };
  }
  if (task.status === "submitted") {
    return { state, error: "A demo submission is already waiting for a simulated decision." };
  }
  const updated: Task = {
    ...task,
    status: "submitted",
    updatedAt: nowIso(),
    submission: {
      text: text.trim(),
      notes: notes.trim(),
      submittedAt: nowIso(),
      submittedBy: actor.address,
    },
    decision: null,
  };
  return {
    state: {
      ...state,
      lastTaskId: taskId,
      tasks: state.tasks.map((t) => (t.id === taskId ? updated : t)),
    },
  };
}

export function libraryEntryForTask(library: LibraryEntry[], taskId: string): LibraryEntry | undefined {
  return library.find((e) => e.taskId === taskId);
}

export function latestLibraryForKeyLocale(
  library: LibraryEntry[],
  key: string,
  locale: string,
): LibraryEntry | undefined {
  return library
    .filter((e) => e.key === key && e.locale === locale)
    .slice()
    .sort((a, b) => b.version - a.version)[0];
}

export function simulateDecision(
  state: DemoState,
  taskId: string,
  outcome: "approved" | "rejected",
): { state: DemoState; error?: string } {
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task) return { state, error: "Task not found." };
  if (task.status !== "submitted" || !task.submission) {
    return { state, error: "Simulate a decision only after a demo submission." };
  }

  const simulatedAt = nowIso();
  const note =
    outcome === "approved"
      ? "DEMO simulation — not GenLayer consensus. No GEN locked or paid. This is not a live onchain result."
      : "DEMO simulation — not GenLayer consensus. Library unchanged. No GEN locked or paid.";

  const updated: Task = {
    ...task,
    status: outcome,
    updatedAt: simulatedAt,
    decision: { outcome, simulatedAt, note },
  };

  let library = state.library;
  if (outcome === "approved") {
    const latestSame = latestLibraryForKeyLocale(library, task.stringKey, task.targetLanguage);
    const version = (latestSame?.version ?? 0) + 1;
    const entry: LibraryEntry = {
      id: generateId("lib"),
      taskId: task.id,
      key: task.stringKey,
      version,
      locale: task.targetLanguage,
      sourceText: task.sourceText,
      translatedText: task.submission.text,
      translatorAddress: task.translatorAddress,
      translatorLabel: task.translatorLabel,
      approvedAt: simulatedAt,
    };
    library = [entry, ...library];
  }

  return {
    state: {
      ...state,
      lastTaskId: taskId,
      library,
      tasks: state.tasks.map((t) => (t.id === taskId ? updated : t)),
    },
  };
}

export function validateCreateInput(input: CreateTaskInput): string[] {
  const errors: string[] = [];
  if (!input.sourceText.trim()) errors.push("Source text is required.");
  if (!input.targetLanguage) errors.push("Target language is required.");
  if (!input.context.trim()) errors.push("Context / UI placement is required.");
  if (!input.meaning.trim()) errors.push("Intended meaning is required.");
  if (input.requirements.filter((r) => r.trim()).length === 0) {
    errors.push("Add at least one requirement.");
  }
  if (!input.translatorAddress.trim()) {
    errors.push("Named translator address is required.");
  } else if (!isHexAddress(input.translatorAddress)) {
    errors.push("Translator must be a 0x address (40 hex chars) or a known demo alias such as elena.eth.");
  } else if (!addressesEqual(input.translatorAddress, DEMO_TRANSLATOR.address)) {
    errors.push(
      "This demo can only name the demo translator (Elena). The Translator switch is a demo role, not a connected wallet.",
    );
  }
  if (!Number.isFinite(input.intendedRewardGen) || input.intendedRewardGen <= 0) {
    errors.push("Intended GEN reward must be a positive number.");
  }
  return errors;
}

export function canSubmit(task: Task, role: Role): boolean {
  const actor = currentActor(role);
  if (!addressesEqual(actor.address, task.translatorAddress)) return false;
  return task.status === "open" || task.status === "in_translation" || task.status === "rejected";
}

export function isNamedTranslator(task: Task, role: Role): boolean {
  return addressesEqual(currentActor(role).address, task.translatorAddress);
}
