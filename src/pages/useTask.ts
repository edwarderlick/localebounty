import { useEffect } from "react";
import { useParams } from "react-router-dom";
import { useDemo } from "../data/DemoContext";

export function useTaskParam() {
  const { id } = useParams();
  const { state, rememberTask } = useDemo();
  const task = state.tasks.find((t) => t.id === id);

  useEffect(() => {
    if (task) rememberTask(task.id);
  }, [task, rememberTask]);

  return { id, task };
}
