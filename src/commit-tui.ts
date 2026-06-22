import {
  type AgentSessionEvent,
  AssistantMessageComponent,
  initTheme,
  rawKeyHint,
  ToolExecutionComponent,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Key,
  matchesKey,
  ProcessTerminal,
  Text,
  type Terminal,
  truncateToWidth,
  TUI,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  cancelledResult,
  completedResult,
  safePendingQuestions,
  type AskUserQuestionPresenter,
  validateAskUserQuestionInput,
} from "./ask-user-question";
import { type AskUiResult, createQuestionnaireComponent } from "./ask-user-question-ui";
import type { AskUserQuestionInput, AskUserQuestionResult } from "./ask-user-question-types";
import { isObjectRecord } from "./tool-result";

export class CommitWorkflowCancelledError extends Error {
  readonly exitCode = 130;

  constructor() {
    super("Commit workflow cancelled.");
    this.name = "CommitWorkflowCancelledError";
  }
}

export type CommitTuiRuntimeOptions = {
  readonly cwd: string;
  readonly toolDefinitions: readonly ToolDefinition[];
  readonly terminal?: Terminal;
};

type RuntimeStatus = "running" | "completed" | "failed" | "cancelled";
type AssistantMessageForRender = Parameters<AssistantMessageComponent["updateContent"]>[0];

type ToolResultForRender = {
  readonly content: Array<{
    readonly type: string;
    readonly text?: string;
    readonly data?: string;
    readonly mimeType?: string;
  }>;
  readonly details?: unknown;
  readonly isError: boolean;
};

type PendingQuestion = {
  readonly cancel: () => void;
};

export class CommitTuiRuntime {
  private readonly terminal: Terminal;
  private readonly ui: TUI;
  private readonly view: CommitTuiView;
  private readonly toolDefinitions: ReadonlyMap<string, ToolDefinition>;
  private readonly cwd: string;
  private readonly tools = new Map<string, ToolExecutionComponent>();
  private readonly unsubscribeInput: () => void;
  private currentAssistant?: AssistantMessageComponent;
  private pendingQuestion?: PendingQuestion;
  private cancelRequested = false;
  private cancelResolve!: () => void;
  private readonly cancelPromise = new Promise<void>((resolve) => {
    this.cancelResolve = resolve;
  });

  constructor(options: CommitTuiRuntimeOptions) {
    initTheme(undefined, false);
    this.cwd = options.cwd;
    this.terminal = options.terminal ?? new ProcessTerminal();
    this.ui = new TUI(this.terminal);
    this.view = new CommitTuiView(this.terminal);
    this.toolDefinitions = new Map(options.toolDefinitions.map((tool) => [tool.name, tool]));
    this.ui.addChild(this.view);
    this.ui.setFocus(this.view);
    this.unsubscribeInput = this.ui.addInputListener((data) => this.handleGlobalInput(data));
  }

  get presenter(): AskUserQuestionPresenter {
    return async (input) => this.askUserQuestion(input);
  }

  get cancelled(): Promise<void> {
    return this.cancelPromise;
  }

  start(): void {
    this.ui.start();
    this.ui.requestRender(true);
  }

  stop(): void {
    this.unsubscribeInput();
    this.resolvePendingQuestionAsCancelled();
    this.ui.stop();
  }

  setStatus(status: RuntimeStatus): void {
    this.cancelRequested = false;
    this.view.setStatus(status);
    this.ui.requestRender(true);
  }

  addNotice(text: string): void {
    this.view.addComponent(new Text(text, 1, 0));
    this.ui.requestRender();
  }

  async flushRender(): Promise<void> {
    this.ui.requestRender(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  handleEvent(event: AgentSessionEvent): void {
    switch (event.type) {
      case "message_start":
      case "message_update":
      case "message_end":
        this.handleMessageEvent(event);
        break;
      case "tool_execution_start":
        this.handleToolStart(event.toolCallId, event.toolName, event.args);
        break;
      case "tool_execution_update":
        this.handleToolUpdate(event.toolCallId, event.args, event.partialResult);
        break;
      case "tool_execution_end":
        this.handleToolEnd(event.toolCallId, event.result, event.isError);
        break;
    }
    this.ui.requestRender();
  }

  private async askUserQuestion(input: AskUserQuestionInput): Promise<AskUserQuestionResult> {
    const validation = validateAskUserQuestionInput(input);
    if (!validation.ok) {
      return {
        status: "error",
        errors: [validation.message],
        pendingQuestions: safePendingQuestions(input),
        error: validation.error,
      };
    }

    return await new Promise<AskUserQuestionResult>((resolve) => {
      let hidden = false;
      const done = (result: AskUiResult) => {
        if (hidden) {
          return;
        }
        hidden = true;
        this.pendingQuestion = undefined;
        handle.hide();
        if (result.status === "completed") {
          resolve(completedResult(result.answers));
          return;
        }
        resolve(cancelledResult(input, result.answers));
      };

      const component = createQuestionnaireComponent(
        input,
        { requestRender: () => this.ui.requestRender() },
        commitTuiTheme,
        { matches: () => false },
        done,
      );
      const handle = this.ui.showOverlay(component, {
        width: "90%",
        maxHeight: "80%",
        anchor: "center",
        margin: 1,
      });
      this.pendingQuestion = {
        cancel: () => {
          component.cancel();
        },
      };
      this.ui.requestRender();
    });
  }

  private handleGlobalInput(data: string) {
    if (matchesKey(data, Key.ctrl("c"))) {
      if (this.cancelRequested) {
        this.view.setStatus("cancelled");
        this.resolvePendingQuestionAsCancelled();
        this.cancelResolve();
      } else {
        this.cancelRequested = true;
        this.view.setCancelWarning(true);
        this.ui.requestRender();
      }
      return { consume: true };
    }

    if (this.cancelRequested) {
      this.cancelRequested = false;
      this.view.setCancelWarning(false);
      this.ui.requestRender();
    }

    return undefined;
  }

  private resolvePendingQuestionAsCancelled(): void {
    const pending = this.pendingQuestion;
    if (pending === undefined) {
      return;
    }
    pending.cancel();
  }

  private handleMessageEvent(
    event: Extract<AgentSessionEvent, { type: "message_start" | "message_update" | "message_end" }>,
  ): void {
    if (!isAssistantMessage(event.message)) {
      return;
    }

    if (event.type === "message_start" || this.currentAssistant === undefined) {
      this.currentAssistant = new AssistantMessageComponent(event.message);
      this.view.addComponent(this.currentAssistant);
      return;
    }

    this.currentAssistant.updateContent(event.message);
    if (event.type === "message_end") {
      this.currentAssistant = undefined;
    }
  }

  private handleToolStart(toolCallId: string, toolName: string, args: unknown): void {
    const component = new ToolExecutionComponent(
      toolName,
      toolCallId,
      args,
      { showImages: false },
      this.toolDefinitions.get(toolName),
      this.ui,
      this.cwd,
    );
    component.markExecutionStarted();
    component.setArgsComplete();
    this.tools.set(toolCallId, component);
    this.view.addComponent(component);
  }

  private handleToolUpdate(toolCallId: string, args: unknown, partialResult: unknown): void {
    const component = this.tools.get(toolCallId);
    if (component === undefined) {
      return;
    }
    component.updateArgs(args);
    if (partialResult !== undefined) {
      component.updateResult(normalizeToolResult(partialResult, false), true);
    }
  }

  private handleToolEnd(toolCallId: string, result: unknown, isError: boolean): void {
    const component = this.tools.get(toolCallId);
    if (component === undefined) {
      return;
    }
    component.updateResult(normalizeToolResult(result, isError), false);
    this.tools.delete(toolCallId);
    if (isError) {
      component.setExpanded(true);
    }
  }
}

export class CommitTuiView implements Component {
  private readonly components: Component[] = [];
  private readonly terminal: Pick<Terminal, "rows">;
  private status: RuntimeStatus = "running";
  private cancelWarning = false;
  private scrollFromBottom = 0;
  private autoFollow = true;

  constructor(terminal: Pick<Terminal, "rows"> = { rows: 24 }) {
    initTheme(undefined, false);
    this.terminal = terminal;
  }

  addComponent(component: Component): void {
    this.components.push(component);
    if (this.autoFollow) {
      this.scrollFromBottom = 0;
    }
  }

  setStatus(status: RuntimeStatus): void {
    this.status = status;
    if (status !== "running") {
      this.cancelWarning = false;
    }
  }

  setCancelWarning(visible: boolean): void {
    this.cancelWarning = visible;
  }

  invalidate(): void {
    for (const component of this.components) {
      component.invalidate();
    }
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.up)) {
      this.scrollBy(1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.scrollBy(-1);
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.scrollBy(Math.max(1, Math.floor(this.terminal.rows / 2)));
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.scrollBy(-Math.max(1, Math.floor(this.terminal.rows / 2)));
      return;
    }
    if (matchesKey(data, Key.home)) {
      this.scrollFromBottom = Number.MAX_SAFE_INTEGER;
      this.autoFollow = false;
      return;
    }
    if (matchesKey(data, Key.end)) {
      this.scrollFromBottom = 0;
      this.autoFollow = true;
    }
  }

  render(width: number): string[] {
    const footer = this.renderFooter(width);
    const bodyHeight = Math.max(1, this.terminal.rows - footer.length);
    const body = this.renderBody(width);
    const maxScroll = Math.max(0, body.length - bodyHeight);
    if (this.scrollFromBottom > maxScroll) {
      this.scrollFromBottom = maxScroll;
    }
    this.autoFollow = this.scrollFromBottom === 0;

    const start = Math.max(0, body.length - bodyHeight - this.scrollFromBottom);
    const visibleBody = body.slice(start, start + bodyHeight);
    while (visibleBody.length < bodyHeight) {
      visibleBody.push("");
    }

    return [...visibleBody.map((line) => truncateToWidth(line, width)), ...footer];
  }

  private scrollBy(delta: number): void {
    this.scrollFromBottom = Math.max(0, this.scrollFromBottom + delta);
    this.autoFollow = this.scrollFromBottom === 0;
  }

  private renderBody(width: number): string[] {
    if (this.components.length === 0) {
      return [commitTuiTheme.fg("dim", "Starting commit workflow...")];
    }

    return this.components.flatMap((component) => component.render(width));
  }

  private renderFooter(width: number): string[] {
    const state = this.cancelWarning
      ? commitTuiTheme.fg("warning", "Press Ctrl+C again to cancel")
      : commitTuiTheme.fg("dim", statusLabel(this.status));
    const scroll = this.autoFollow
      ? commitTuiTheme.fg("dim", "follow")
      : commitTuiTheme.fg("warning", `scroll ${this.scrollFromBottom}`);
    const hints = [
      rawKeyHint("up/down", "scroll"),
      rawKeyHint("home/end", "jump"),
      rawKeyHint("ctrl+c", "cancel"),
    ].join(commitTuiTheme.fg("dim", "  "));
    const first = fitColumns([state, scroll], width);
    const second = truncateToWidth(hints, width);
    return [commitTuiTheme.fg("dim", "─".repeat(Math.max(0, width))), first, second];
  }
}

function normalizeToolResult(result: unknown, isError: boolean): ToolResultForRender {
  if (isObjectRecord(result) && Array.isArray(result.content)) {
    return {
      content: result.content.filter(isToolContent),
      details: result.details,
      isError,
    };
  }

  return {
    content: [{ type: "text", text: result === undefined ? "" : String(result) }],
    isError,
  };
}

function isToolContent(value: unknown): value is ToolResultForRender["content"][number] {
  return isObjectRecord(value) && typeof value.type === "string";
}

function isAssistantMessage(value: unknown): value is AssistantMessageForRender {
  return isObjectRecord(value) && value.role === "assistant" && Array.isArray(value.content);
}

function statusLabel(status: RuntimeStatus): string {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "running":
      return "running";
  }
}

function fitColumns(parts: readonly string[], width: number): string {
  if (parts.length === 0) {
    return "";
  }
  if (parts.length === 1) {
    return truncateToWidth(parts[0] ?? "", width);
  }

  const [left = "", right = ""] = parts;
  const leftWidth = visibleWidth(left);
  const rightWidth = visibleWidth(right);
  if (leftWidth + rightWidth + 1 <= width) {
    return `${left}${" ".repeat(width - leftWidth - rightWidth)}${right}`;
  }
  return truncateToWidth(`${left} ${right}`, width);
}

const ANSI_RESET = "\x1b[0m";

const fgColors: Record<string, string> = {
  accent: "138;190;183",
  success: "181;189;104",
  error: "204;102;102",
  warning: "255;255;0",
  muted: "128;128;128",
  dim: "102;102;102",
  text: "212;212;212",
  toolTitle: "212;212;212",
};

export const commitTuiTheme = {
  fg(name: string, text: string): string {
    const color = fgColors[name];
    return color === undefined ? text : `\x1b[38;2;${color}m${text}${ANSI_RESET}`;
  },
  bold(text: string): string {
    return `\x1b[1m${text}${ANSI_RESET}`;
  },
};
