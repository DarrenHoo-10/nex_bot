export type TodoStatus = "todo" | "running" | "review" | "done";
export interface TodoStep {
  text: string;
  done: boolean;
}
export interface TodoItem {
  id: string;
  title: string;
  description: string;
  owner: string;
  date: string;
  priority: string;
  status: TodoStatus;
  version: number;
  steps: TodoStep[];
  taskId: string | null;
  taskStatus: string | null;
  result: string;
  log: string[];
  createdAt: number;
  updatedAt: number;
}
