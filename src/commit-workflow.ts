import type { AgentSessionEvent, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  ASK_USER_QUESTION_TOOL_NAME,
  createAskUserQuestionTool,
  type QuestionPromptAdapter,
} from "./ask-user-question";
import { validateBaseBranchName, type CliOptions } from "./cli";
import {
  COMMIT_AGENT_TOOL_NAMES,
  createCommitAgentSession,
  type CommitAgentSessionOptions,
} from "./pi-session";

export type CommitWorkflowIo = {
  readonly stdout: { write: (chunk: string) => unknown };
  readonly stderr: { write: (chunk: string) => unknown };
};

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
  readonly options: CliOptions;
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
  let questionToolFailure: string | undefined;
  const unsubscribe = session.subscribe((event) => {
    streamCommitWorkflowEvent(event, io);
    questionToolFailure ??= getQuestionToolFailure(event);
  });

  try {
    if (modelFallbackMessage !== undefined) {
      io.stderr.write(`Note: ${modelFallbackMessage}\n`);
    }
    await session.prompt(buildCommitSkillPrompt(options.options));
    if (questionToolFailure !== undefined) {
      throw new Error(questionToolFailure);
    }
  } finally {
    unsubscribe();
    session.dispose();
  }
}

export function buildCommitSkillPrompt(options: CliOptions): string {
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
    const baseError = validateBaseBranchName(options.base);
    if (baseError !== undefined) {
      throw new Error(baseError);
    }
    args.push("--base", options.base);
  }

  return ["/skill:commit", ...args].join(" ");
}

export function streamCommitWorkflowEvent(event: AgentSessionEvent, io: CommitWorkflowIo): void {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    io.stdout.write(event.assistantMessageEvent.delta);
    return;
  }

  if (event.type === "tool_execution_start") {
    io.stderr.write(`\n[tool] ${event.toolName}\n`);
    return;
  }

  if (event.type === "tool_execution_end" && event.isError) {
    const errorText = extractToolResultText(event.result);
    io.stderr.write(
      errorText.length > 0
        ? `[tool] ${event.toolName} failed\n${errorText}\n`
        : `[tool] ${event.toolName} failed\n`,
    );
  }
}

export function getQuestionToolFailure(event: AgentSessionEvent): string | undefined {
  if (event.type !== "tool_execution_end" || event.toolName !== ASK_USER_QUESTION_TOOL_NAME) {
    return undefined;
  }

  const details = extractToolResultDetails(event.result);
  if (isCancelledQuestionResult(details)) {
    return `Question required but no answer was available (${details.reason}).`;
  }

  if (isErroredQuestionResult(details)) {
    return `Question tool failed: ${details.errors.join("; ")}`;
  }

  if (event.isError) {
    const errorText = extractToolResultText(event.result);
    return errorText.length > 0
      ? `Question tool failed: ${errorText}`
      : "Question tool failed: tool execution failed.";
  }

  return undefined;
}

function extractToolResultText(result: unknown): string {
  if (!isObjectRecord(result)) {
    return "";
  }

  const content = result.content;
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((item) => {
      if (isObjectRecord(item)) {
        return item.type === "text" && typeof item.text === "string" ? item.text : "";
      }
      return "";
    })
    .filter((text) => text.length > 0)
    .join("\n");
}

function extractToolResultDetails(result: unknown): unknown {
  return isObjectRecord(result) ? result.details : undefined;
}

function isCancelledQuestionResult(
  details: unknown,
): details is { readonly status: "cancelled"; readonly reason: string } {
  return (
    isObjectRecord(details) && details.status === "cancelled" && typeof details.reason === "string"
  );
}

function isErroredQuestionResult(
  details: unknown,
): details is { readonly status: "error"; readonly errors: readonly string[] } {
  return (
    isObjectRecord(details) &&
    details.status === "error" &&
    Array.isArray(details.errors) &&
    details.errors.every((error) => typeof error === "string")
  );
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
