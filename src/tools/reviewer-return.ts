import { Tool } from "./types.js";

/**
 * Creates a tool for reviewers to submit their final review.
 * The orchestrator will inspect the reviewer's conversation history
 * to read the structured report and approval status.
 */
export function createReviewerReturnTool(): Tool {
  return {
    definition: {
      name: "return_review",
      description:
        "Submit your final review report and approval decision. Call this as your LAST action after inspecting code and running tests. Do not output any additional text after calling this tool.",
      parameters: {
        report: {
          type: "string",
          description:
            "Comprehensive review report. Include: FILES_CHECKED (what you inspected), TEST_APPROACH (what your independent test exercised), KEY_FINDINGS (bugs, issues, gaps), IMPACT_ON_PLAN (whether remaining subtasks should change).",
        },
        approved: {
          type: "boolean",
          description: "true if the code passes review and your independent test succeeded. false if it needs improvements.",
        },
      },
    },
    async execute(args) {
      const report = args.report as string;
      const approved = args.approved as boolean;
      return [
        "REVIEW_SUBMITTED",
        `APPROVED: ${approved}`,
        `REPORT:`,
        report,
      ].join("\n");
    },
  };
}
