export type Role = "owner" | "translator";

export type TaskStatus = "open" | "in_translation" | "submitted" | "approved" | "rejected";

export type Accent = "orange" | "lime" | "cyan" | "sand" | "pink";

export interface TaskSubmission {
  text: string;
  notes: string;
  submittedAt: string;
  submittedBy: string;
}

export interface TaskDecision {
  outcome: "approved" | "rejected";
  simulatedAt: string;
  note: string;
}

export interface Task {
  id: string;
  title: string;
  stringKey: string;
  module: string;
  sourceLanguage: string;
  targetLanguage: string;
  sourceText: string;
  context: string;
  meaning: string;
  requirements: string[];
  translatorAddress: string;
  translatorLabel: string;
  ownerAddress: string;
  intendedRewardGen: number;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  accent: Accent;
  submission: TaskSubmission | null;
  decision: TaskDecision | null;
}

export interface LibraryEntry {
  id: string;
  taskId: string;
  key: string;
  version: number;
  locale: string;
  sourceText: string;
  translatedText: string;
  translatorAddress: string;
  translatorLabel: string;
  approvedAt: string;
}

export interface DemoState {
  role: Role;
  tasks: Task[];
  library: LibraryEntry[];
  lastTaskId: string | null;
}

export interface CreateTaskInput {
  sourceText: string;
  targetLanguage: string;
  context: string;
  meaning: string;
  requirements: string[];
  translatorAddress: string;
  intendedRewardGen: number;
  title?: string;
  module?: string;
}

export const LANGUAGES = [
  { code: "ES-ES", label: "Spanish (Spain)", short: "ES" },
  { code: "JA-JP", label: "Japanese", short: "JA" },
  { code: "DE-DE", label: "German", short: "DE" },
  { code: "FR-FR", label: "French", short: "FR" },
  { code: "PT-BR", label: "Portuguese (Brazil)", short: "PT" },
] as const;

export const MODULES = [
  "Checkout & Fulfillment",
  "Auth & Session",
  "Settings & Preferences",
  "Billing & Subscriptions",
  "Wallet & Web3",
] as const;
