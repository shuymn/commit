import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { extractToolResultText, isObjectRecord } from "./tool-result";

export type CommitWorkflowIo = {
  readonly stdout: { write: (chunk: string) => unknown };
  readonly stderr: { write: (chunk: string) => unknown; readonly columns?: number };
};

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
