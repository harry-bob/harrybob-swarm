export interface Subtask {
  id: string;
  title: string;
  description: string;
  dependencies: string[];  // ids of subtasks that must complete first
  verification?: string;   // optional shell command to verify subtask completion
}

export interface TaskPlan {
  goal: string;
  subtasks: Subtask[];
}
