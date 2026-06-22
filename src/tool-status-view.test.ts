import { describe, expect, test } from "bun:test";
import { streamCommitWorkflowEvent } from "./tool-status-view";

const DEFAULT_TOOL_STATUS_BORDER =
  "╰─────────────────────────────────────────────────────────────────────────────\n";

describe("streamCommitWorkflowEvent", () => {
  test("streams assistant text to stdout", () => {
    let stdout = "";
    let stderr = "";

    streamCommitWorkflowEvent(
      {
        type: "message_update",
        message: {} as never,
        assistantMessageEvent: { type: "text_delta", delta: "hello" } as never,
      },
      {
        stdout: {
          write: (chunk) => {
            stdout += chunk;
          },
        },
        stderr: {
          write: (chunk) => {
            stderr += chunk;
          },
        },
      },
    );

    expect(stdout).toBe("hello");
    expect(stderr).toBe("");
  });

  test("reports tool progress to stderr", () => {
    let stdout = "";
    let stderr = "";

    streamCommitWorkflowEvent(
      {
        type: "tool_execution_start",
        toolCallId: "tool-1",
        toolName: "bash",
        args: { command: "git status --short" },
      },
      {
        stdout: {
          write: (chunk) => {
            stdout += chunk;
          },
        },
        stderr: {
          write: (chunk) => {
            stderr += chunk;
          },
        },
      },
    );

    expect(stdout).toBe("");
    expect(stderr).toBe(
      `\n╭─ bash\n│ running\n│ $ git status --short\n${DEFAULT_TOOL_STATUS_BORDER}`,
    );
  });

  test("prints error tool text to stderr", () => {
    let stderr = "";

    streamCommitWorkflowEvent(
      {
        type: "tool_execution_end",
        toolCallId: "tool-1",
        toolName: "bash",
        result: { content: [{ type: "text", text: "hook failed" }], details: {} },
        isError: true,
      },
      {
        stdout: { write: () => undefined },
        stderr: {
          write: (chunk) => {
            stderr += chunk;
          },
        },
      },
    );

    expect(stderr).toBe(`╭─ bash failed\n│ hook failed\n${DEFAULT_TOOL_STATUS_BORDER}`);
  });

  test("falls back safely for invalid terminal widths", () => {
    let stderr = "";

    expect(() =>
      streamCommitWorkflowEvent(
        {
          type: "tool_execution_start",
          toolCallId: "tool-1",
          toolName: "bash",
          args: { command: "git status --short" },
        },
        {
          stdout: { write: () => undefined },
          stderr: {
            columns: Number.POSITIVE_INFINITY,
            write: (chunk) => {
              stderr += chunk;
            },
          },
        },
      ),
    ).not.toThrow();

    expect(stderr).toContain(DEFAULT_TOOL_STATUS_BORDER);
  });

  test("wraps long error output without dropping diagnostics", () => {
    let stderr = "";
    const errorText = `compile failed ${"because ".repeat(8)}at src/commit-workflow.ts:123`;

    streamCommitWorkflowEvent(
      {
        type: "tool_execution_end",
        toolCallId: "tool-1",
        toolName: "bash",
        result: { content: [{ type: "text", text: errorText }], details: {} },
        isError: true,
      },
      {
        stdout: { write: () => undefined },
        stderr: {
          columns: 32,
          write: (chunk) => {
            stderr += chunk;
          },
        },
      },
    );

    expect(stderr).toContain("src/commit-workflow.ts:123");
    expect(stderr).not.toContain("...");
  });
});
