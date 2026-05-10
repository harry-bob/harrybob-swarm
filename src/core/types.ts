export interface Subtask {
  id: string;
  title: string;
  description: string;
  dependencies: string[];  // ids of subtasks that must complete first
}

export interface TaskPlan {
  goal: string;
  subtasks: Subtask[];
}
