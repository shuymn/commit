import type { AgentSessionEvent, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
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

export type CommitWorkflowIo = {
  readonly stdout: { write: (chunk: string) => unknown };
  readonly stderr: { write: (chunk: string) => unknown; readonly columns?: number };
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

export function streamCommitWorkflowEvent(event: AgentSessionEvent, io: CommitWorkflowIo): void {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    io.stdout.write(event.assistantMessageEvent.delta);
    return;
  }

  if (event.type === "tool_execution_start") {
    const summary = getToolSummary(event.args);
    io.stderr.write(
      `\n${renderToolStatusBox(io.stderr, event.toolName, [
        "running",
        ...(summary ? [summary] : []),
      ])}`,
    );
    return;
  }

  if (event.type === "tool_execution_end" && event.isError) {
    const errorText = extractToolResultText(event.result).trimEnd();
    io.stderr.write(
      renderToolStatusBox(
        io.stderr,
        `${event.toolName} failed`,
        wrapToolStatusBody(io.stderr, errorText.length > 0 ? errorText : "no output"),
      ),
    );
  }
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

function renderToolStatusBox(
  terminal: { readonly columns?: number },
  title: string,
  bodyLines: readonly string[],
): string {
  const width = normalizeTerminalWidth(terminal.columns);
  const contentWidth = Math.max(1, width - 2);
  return `${[
    truncateToWidth(`╭─ ${title}`, width),
    ...bodyLines.map((line) => truncateToWidth(`│ ${line}`, width)),
    truncateToWidth("╰─".padEnd(contentWidth, "─"), width),
  ].join("\n")}\n`;
}

function wrapToolStatusBody(terminal: { readonly columns?: number }, body: string): string[] {
  const contentWidth = Math.max(1, normalizeTerminalWidth(terminal.columns) - 2);
  return body.split("\n").flatMap((line) => wrapTextWithAnsi(line, contentWidth));
}

function normalizeTerminalWidth(columns: number | undefined): number {
  return typeof columns === "number" && Number.isFinite(columns) && columns > 0
    ? Math.max(2, Math.floor(columns))
    : 80;
}

function getToolSummary(args: unknown): string | undefined {
  if (!isObjectRecord(args)) {
    return undefined;
  }

  if (typeof args.command === "string") {
    return `$ ${singleLine(args.command)}`;
  }

  if (typeof args.path === "string") {
    return args.path;
  }

  if (typeof args.query === "string") {
    return singleLine(args.query);
  }

  return undefined;
}

function singleLine(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > 120 ? `${collapsed.slice(0, 117)}...` : collapsed;
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
function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
