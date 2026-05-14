import { z } from "zod";

export const SubtaskSchema = z.object({
  id: z.string().min(1, "Subtask id must not be empty"),
  title: z.string().min(1, "Subtask title must not be empty"),
  description: z.string().min(1, "Subtask description must not be empty"),
  dependencies: z.array(z.string()),
  verification: z.string().optional(),
  filesExpected: z.array(z.string()).optional(),
  estimatedComplexity: z.enum(["low", "medium", "high"]).optional(),
});

export const TaskPlanSchema = z.object({
  goal: z.string().min(1, "Plan goal must not be empty"),
  rationale: z.string().optional(),
  subtasks: z.array(SubtaskSchema).min(1, "Plan must have at least one subtask"),
});

export type ValidatedTaskPlan = z.infer<typeof TaskPlanSchema>;
