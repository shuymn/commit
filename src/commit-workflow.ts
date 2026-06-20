import type { AgentSessionEvent, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
  ASK_USER_QUESTION_TOOL_NAME,
  createAskUserQuestionTool,
  type QuestionPromptAdapter,
} from "./ask-user-question";
import type { CliOptions } from "./cli";
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
    io.stderr.write(
      `\n${renderToolStatus(io.stderr, event.toolName, ["running", getToolSummary(event.args)])}`,
    );
    return;
  }

  if (event.type === "tool_execution_end" && event.isError) {
    const errorText = extractToolResultText(event.result).trimEnd();
    io.stderr.write(
      renderToolStatus(
        io.stderr,
        `${event.toolName} failed`,
        errorText.length > 0 ? errorText : "no output",
        {
          bodyMode: "wrap",
        },
      ),
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

function renderToolStatus(
  terminal: { readonly columns?: number },
  title: string,
  body: string | readonly (string | undefined)[],
  options: { readonly bodyMode?: "truncate" | "wrap" } = {},
): string {
  const width = normalizeTerminalWidth(terminal.columns);
  return `${renderToolStatusLines(title, body, options.bodyMode ?? "truncate", width).join("\n")}\n`;
}

function normalizeTerminalWidth(columns: number | undefined): number {
  return typeof columns === "number" && Number.isFinite(columns) && columns > 0
    ? Math.max(2, Math.floor(columns))
    : 80;
}

function renderToolStatusLines(
  title: string,
  body: string | readonly (string | undefined)[],
  bodyMode: "truncate" | "wrap",
  width: number,
): string[] {
  const contentWidth = Math.max(1, width - 2);

  return [
    truncateToWidth(`╭─ ${title}`, width),
    ...renderToolStatusBodyLines(body, bodyMode, width, contentWidth),
    truncateToWidth("╰─".padEnd(contentWidth, "─"), width),
  ];
}

function renderToolStatusBodyLines(
  body: string | readonly (string | undefined)[],
  bodyMode: "truncate" | "wrap",
  width: number,
  contentWidth: number,
): string[] {
  const bodyLines =
    typeof body === "string"
      ? body.split("\n")
      : body.filter((line): line is string => line !== undefined && line.length > 0);

  if (bodyMode === "truncate") {
    return bodyLines.map((line) => truncateToWidth(`│ ${line}`, width));
  }

  return bodyLines.flatMap((line) =>
    wrapTextWithAnsi(line, contentWidth).map((wrappedLine) => `│ ${wrappedLine}`),
  );
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
