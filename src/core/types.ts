export interface Subtask {
  id: string;
  title: string;
  description: string;
  dependencies?: string[];  // kept for backward-compat; ignored by executor (runs linearly)
  verification?: string;   // optional shell command to verify subtask completion
  filesExpected?: string[];  // files this subtask is expected to create or modify
  estimatedComplexity?: "low" | "medium" | "high";
}

export interface TaskPlan {
  goal: string;
  rationale?: string;      // why the architect chose this plan
  subtasks: Subtask[];
}
