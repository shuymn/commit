import type { AgentSessionEvent, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  ASK_USER_QUESTION_TOOL_NAME,
  createAskUserQuestionTool,
  toAskUserQuestionResult,
  type QuestionPromptAdapter,
} from "./ask-user-question";
import type { CommitOptions } from "./commit-options";
import {
  COMMIT_AGENT_TOOL_NAMES,
  createCommitAgentSession,
  type CommitAgentSessionOptions,
} from "./pi-session";
import { extractToolResultDetails, extractToolResultText } from "./tool-result";
import { type CommitWorkflowIo, streamCommitWorkflowEvent } from "./tool-status-view";

export type { CommitWorkflowIo };

export type CommitWorkflowSession = {
  readonly prompt: (text: string) => Promise<void>;
  readonly subscribe: (listener: (event: AgentSessionEvent) => void) => () => void;
  readonly dispose: () => void;
};

export type CommitWorkflowSessionFactory = (options: CommitAgentSessionOptions) => Promise<{
  readonly session: CommitWorkflowSession;
  readonly modelFallbackMessage?: string;
}>;

export type RunCommitWorkflowOptions = {
  readonly cwd: string;
  readonly options: CommitOptions;
  readonly io?: CommitWorkflowIo;
  readonly env?: Record<string, string | undefined>;
  readonly createSession?: CommitWorkflowSessionFactory;
  readonly questionPromptAdapter?: QuestionPromptAdapter;
};

export async function runCommitWorkflow(options: RunCommitWorkflowOptions): Promise<void> {
  const io = options.io ?? { stdout: process.stdout, stderr: process.stderr };
  const createSession = options.createSession ?? createCommitAgentSession;
  const questionTool = createAskUserQuestionTool(options.questionPromptAdapter);
  const sessionResult = await createSession({
    cwd: options.cwd,
    env: options.env ?? process.env,
    customTools: [questionTool] satisfies readonly ToolDefinition[],
    toolNames: [...COMMIT_AGENT_TOOL_NAMES, ASK_USER_QUESTION_TOOL_NAME],
  });
  const { session, modelFallbackMessage } = sessionResult;
  // The question tool terminates the session on failure; we record the first
  // failure here and rethrow it once the prompt loop has finished.
  let firstQuestionToolFailure: string | undefined;
  const unsubscribe = session.subscribe((event) => {
    streamCommitWorkflowEvent(event, io);
    firstQuestionToolFailure ??= getQuestionToolFailure(event);
  });

  try {
    if (modelFallbackMessage !== undefined) {
      io.stderr.write(`Note: ${modelFallbackMessage}\n`);
    }
    await session.prompt(buildCommitSkillPrompt(options.options));
    if (firstQuestionToolFailure !== undefined) {
      throw new Error(firstQuestionToolFailure);
    }
  } finally {
    unsubscribe();
    session.dispose();
  }
}

export function buildCommitSkillPrompt(options: CommitOptions): string {
  const args: string[] = [];
  if (options.language === "english") {
    args.push("--english");
  }
  if (options.language === "japanese") {
    args.push("--japanese");
  }
  if (options.branch) {
    args.push("--branch");
  }
  if (options.base !== undefined) {
    args.push("--base", options.base);
  }

  return ["/skill:commit", ...args].join(" ");
}

export function getQuestionToolFailure(event: AgentSessionEvent): string | undefined {
  if (event.type !== "tool_execution_end" || event.toolName !== ASK_USER_QUESTION_TOOL_NAME) {
    return undefined;
  }

  const result = toAskUserQuestionResult(extractToolResultDetails(event.result));
  if (result?.status === "cancelled") {
    return `Question required but no answer was available (${result.reason}).`;
  }

  if (result?.status === "error") {
    return `Question tool failed: ${result.errors.join("; ")}`;
  }

  if (event.isError) {
    const errorText = extractToolResultText(event.result);
    return errorText.length > 0
      ? `Question tool failed: ${errorText}`
      : "Question tool failed: tool execution failed.";
  }

  return undefined;
}
