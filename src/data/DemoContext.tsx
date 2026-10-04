import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { CreateTaskInput, DemoState, Role, Task } from "../types";
import {
  canSubmit,
  createTask,
  isNamedTranslator,
  loadState,
  saveState,
  setRole,
  simulateDecision,
  submitTranslation,
  touchTask,
  validateCreateInput,
} from "./demoStore";

interface DemoContextValue {
  state: DemoState;
  role: Role;
  tasks: Task[];
  setDemoRole: (role: Role) => void;
  rememberTask: (taskId: string) => void;
  addTask: (input: CreateTaskInput) => { task: Task | null; errors: string[] };
  submit: (taskId: string, text: string, notes: string) => string | undefined;
  simulate: (taskId: string, outcome: "approved" | "rejected") => string | undefined;
  canSubmitTask: (task: Task) => boolean;
  namedTranslator: (task: Task) => boolean;
}

const DemoContext = createContext<DemoContextValue | null>(null);

export function DemoProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DemoState>(() => loadState());
  const stateRef = useRef(state);
  stateRef.current = state;

  function commit(next: DemoState) {
    stateRef.current = next;
    setState(next);
  }

  useEffect(() => {
    saveState(state);
  }, [state]);

  const setDemoRole = useCallback((role: Role) => {
    commit(setRole(stateRef.current, role));
  }, []);

  const rememberTask = useCallback((taskId: string) => {
    const current = stateRef.current;
    if (current.lastTaskId === taskId) return;
    commit(touchTask(current, taskId));
  }, []);

  const addTask = useCallback((input: CreateTaskInput) => {
    const errors = validateCreateInput(input);
    if (errors.length) return { task: null as Task | null, errors };
    const result = createTask(stateRef.current, input);
    commit(result.state);
    return { task: result.task, errors: [] };
  }, []);

  const submit = useCallback((taskId: string, text: string, notes: string) => {
    const result = submitTranslation(stateRef.current, taskId, text, notes);
    if (result.error) return result.error;
    commit(result.state);
    return undefined;
  }, []);

  const simulate = useCallback((taskId: string, outcome: "approved" | "rejected") => {
    const result = simulateDecision(stateRef.current, taskId, outcome);
    if (result.error) return result.error;
    commit(result.state);
    return undefined;
  }, []);

  const value = useMemo<DemoContextValue>(
    () => ({
      state,
      role: state.role,
      tasks: state.tasks,
      setDemoRole,
      rememberTask,
      addTask,
      submit,
      simulate,
      canSubmitTask: (task) => canSubmit(task, state.role),
      namedTranslator: (task) => isNamedTranslator(task, state.role),
    }),
    [state, setDemoRole, rememberTask, addTask, submit, simulate],
  );

  return <DemoContext.Provider value={value}>{children}</DemoContext.Provider>;
}

export function useDemo() {
  const ctx = useContext(DemoContext);
  if (!ctx) throw new Error("useDemo must be used within DemoProvider");
  return ctx;
}
