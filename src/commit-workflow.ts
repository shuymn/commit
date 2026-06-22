import type { AgentSessionEvent, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  ASK_USER_QUESTION_TOOL_NAME,
  createAskUserQuestionTool,
  toAskUserQuestionResult,
  type QuestionPromptAdapter,
} from "./ask-user-question";
import type { CommitOptions } from "./commit-options";
import { CommitTuiRuntime, CommitWorkflowCancelledError } from "./commit-tui";
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
  readonly uiMode?: "tui" | "plain";
  readonly io?: CommitWorkflowIo;
  readonly env?: Record<string, string | undefined>;
  readonly createSession?: CommitWorkflowSessionFactory;
  readonly questionPromptAdapter?: QuestionPromptAdapter;
};

export async function runCommitWorkflow(options: RunCommitWorkflowOptions): Promise<void> {
  const io = options.io ?? { stdout: process.stdout, stderr: process.stderr };
  const createSession = options.createSession ?? createCommitAgentSession;
  let tuiRuntime: CommitTuiRuntime | undefined;
  const questionTool = createAskUserQuestionTool(
    options.uiMode === "tui"
      ? {
          presenter: async (input) => {
            if (tuiRuntime === undefined) {
              return {
                status: "cancelled",
                reason: "no_ui",
                answers: [],
                pendingQuestions: input.questions,
                error: "no_ui",
              };
            }
            return await tuiRuntime.presenter(input);
          },
        }
      : { promptAdapter: options.questionPromptAdapter },
  );
  const sessionResult = await createSession({
    cwd: options.cwd,
    env: options.env ?? process.env,
    customTools: [questionTool] satisfies readonly ToolDefinition[],
    toolNames: [...COMMIT_AGENT_TOOL_NAMES, ASK_USER_QUESTION_TOOL_NAME],
  });
  const { session, modelFallbackMessage } = sessionResult;

  if (options.uiMode === "tui") {
    tuiRuntime = new CommitTuiRuntime({
      cwd: options.cwd,
      toolDefinitions: [questionTool],
    });
    await runCommitWorkflowWithTui({
      session,
      runtime: tuiRuntime,
      modelFallbackMessage,
      prompt: buildCommitSkillPrompt(options.options),
    });
    return;
  }

  await runCommitWorkflowPlain({
    session,
    io,
    modelFallbackMessage,
    prompt: buildCommitSkillPrompt(options.options),
  });
}

type RunCommitWorkflowPlainOptions = {
  readonly session: CommitWorkflowSession;
  readonly io: CommitWorkflowIo;
  readonly modelFallbackMessage?: string;
  readonly prompt: string;
};

async function runCommitWorkflowPlain(options: RunCommitWorkflowPlainOptions): Promise<void> {
  const { session, io, modelFallbackMessage, prompt } = options;
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
    await session.prompt(prompt);
    if (firstQuestionToolFailure !== undefined) {
      throw new Error(firstQuestionToolFailure);
    }
  } finally {
    unsubscribe();
    session.dispose();
  }
}

type RunCommitWorkflowWithTuiOptions = {
  readonly session: CommitWorkflowSession;
  readonly runtime: CommitTuiRuntime;
  readonly modelFallbackMessage?: string;
  readonly prompt: string;
};

async function runCommitWorkflowWithTui(options: RunCommitWorkflowWithTuiOptions): Promise<void> {
  const { session, runtime, modelFallbackMessage, prompt } = options;
  let firstQuestionToolFailure: string | undefined;
  let runtimeStarted = false;
  const unsubscribe = session.subscribe((event) => {
    runtime.handleEvent(event);
    firstQuestionToolFailure ??= getQuestionToolFailure(event);
  });

  try {
    runtime.start();
    runtimeStarted = true;
    if (modelFallbackMessage !== undefined) {
      runtime.addNotice(`Note: ${modelFallbackMessage}`);
    }

    const promptResult = session.prompt(prompt).then(
      () => ({ kind: "completed" as const }),
      (error: unknown) => ({ kind: "failed" as const, error }),
    );
    const result = await Promise.race([
      promptResult,
      runtime.cancelled.then(() => ({ kind: "cancelled" as const })),
    ]);

    if (result.kind === "cancelled") {
      runtime.setStatus("cancelled");
      throw new CommitWorkflowCancelledError();
    }
    if (result.kind === "failed") {
      runtime.setStatus("failed");
      throw result.error;
    }
    if (firstQuestionToolFailure !== undefined) {
      runtime.setStatus("failed");
      throw new Error(firstQuestionToolFailure);
    }
    runtime.setStatus("completed");
  } catch (error) {
    if (runtimeStarted && !(error instanceof CommitWorkflowCancelledError)) {
      runtime.setStatus("failed");
    }
    throw error;
  } finally {
    if (runtimeStarted) {
      await runtime.flushRender();
    }
    unsubscribe();
    try {
      runtime.stop();
    } finally {
      session.dispose();
    }
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
    return `Question required but no answer was available (${result.error ?? result.reason}).`;
  }

  if (result?.status === "error") {
    return `Question tool failed${result.error !== undefined ? ` (${result.error})` : ""}: ${result.errors.join("; ")}`;
  }

  if (event.isError) {
    const errorText = extractToolResultText(event.result);
    return errorText.length > 0
      ? `Question tool failed: ${errorText}`
      : "Question tool failed: tool execution failed.";
  }

  return undefined;
}
