import { describe, expect, test } from "bun:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { ASK_USER_QUESTION_TOOL_NAME } from "./ask-user-question";
import {
  buildCommitSkillPrompt,
  getQuestionToolFailure,
  runCommitWorkflow,
  streamCommitWorkflowEvent,
  type CommitWorkflowSession,
} from "./commit-workflow";
import { COMMIT_AGENT_TOOL_NAMES, type CommitAgentSessionOptions } from "./pi-session";

describe("buildCommitSkillPrompt", () => {
  test("maps empty options to a forced commit skill invocation", () => {
    expect(buildCommitSkillPrompt({ branch: false })).toBe("/skill:commit");
  });

  test("maps selected CLI options to skill arguments", () => {
    expect(buildCommitSkillPrompt({ language: "japanese", branch: true, base: "main" })).toBe(
      "/skill:commit --japanese --branch --base main",
    );
  });

  test("rejects unsafe base values before building the prompt", () => {
    expect(() => buildCommitSkillPrompt({ branch: true, base: "main --japanese" })).toThrow(
      "--base must be a safe branch name",
    );
  });
});

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
        args: {},
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
    expect(stderr).toBe("\n[tool] bash\n");
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

    expect(stderr).toBe("[tool] bash failed\nhook failed\n");
  });
});

describe("getQuestionToolFailure", () => {
  test("extracts non-TTY cancellation from ask_user_question results", () => {
    expect(
      getQuestionToolFailure({
        type: "tool_execution_end",
        toolCallId: "tool-1",
        toolName: ASK_USER_QUESTION_TOOL_NAME,
        result: { content: [], details: { status: "cancelled", reason: "non_tty" } },
        isError: false,
      }),
    ).toBe("Question required but no answer was available (non_tty).");
  });

  test("extracts unstructured ask_user_question execution errors", () => {
    expect(
      getQuestionToolFailure({
        type: "tool_execution_end",
        toolCallId: "tool-1",
        toolName: ASK_USER_QUESTION_TOOL_NAME,
        result: { content: [{ type: "text", text: "schema failed" }], details: {} },
        isError: true,
      }),
    ).toBe("Question tool failed: schema failed");
  });
});

describe("runCommitWorkflow", () => {
  test("creates a constrained session, prompts the commit skill, and disposes", async () => {
    const createdOptions: CommitAgentSessionOptions[] = [];
    const prompts: string[] = [];
    const events: Array<(event: AgentSessionEvent) => void> = [];
    let unsubscribed = false;
    let disposed = false;
    let stdout = "";
    let stderr = "";

    const session: CommitWorkflowSession = {
      prompt: async (text) => {
        prompts.push(text);
        events.forEach((listener) => {
          listener({
            type: "message_update",
            message: {} as never,
            assistantMessageEvent: { type: "text_delta", delta: "started" } as never,
          });
        });
      },
      subscribe: (listener) => {
        events.push(listener);
        return () => {
          unsubscribed = true;
        };
      },
      dispose: () => {
        disposed = true;
      },
    };

    await runCommitWorkflow({
      cwd: "/repo",
      options: { language: "english", branch: true, base: "main" },
      env: { COMMIT_SKILL_PATH: "/skills/commit/SKILL.md" },
      io: {
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
      createSession: async (options) => {
        createdOptions.push(options);
        return { session, modelFallbackMessage: "fallback model" };
      },
    });

    expect(createdOptions).toHaveLength(1);
    expect(createdOptions[0]).toMatchObject({
      cwd: "/repo",
      env: { COMMIT_SKILL_PATH: "/skills/commit/SKILL.md" },
      toolNames: [...COMMIT_AGENT_TOOL_NAMES, ASK_USER_QUESTION_TOOL_NAME],
    });
    expect(createdOptions[0]?.customTools?.map((tool) => tool.name)).toEqual([
      ASK_USER_QUESTION_TOOL_NAME,
    ]);
    expect(prompts).toEqual(["/skill:commit --english --branch --base main"]);
    expect(stdout).toBe("started");
    expect(stderr).toBe("Note: fallback model\n");
    expect(unsubscribed).toBe(true);
    expect(disposed).toBe(true);
  });

  test("fails clearly when ask_user_question cannot answer", async () => {
    const events: Array<(event: AgentSessionEvent) => void> = [];
    let unsubscribed = false;
    let disposed = false;

    const session: CommitWorkflowSession = {
      prompt: async () => {
        events.forEach((listener) => {
          listener({
            type: "tool_execution_end",
            toolCallId: "tool-1",
            toolName: ASK_USER_QUESTION_TOOL_NAME,
            result: { content: [], details: { status: "cancelled", reason: "non_tty" } },
            isError: false,
          });
        });
      },
      subscribe: (listener) => {
        events.push(listener);
        return () => {
          unsubscribed = true;
        };
      },
      dispose: () => {
        disposed = true;
      },
    };

    await expect(
      runCommitWorkflow({
        cwd: "/repo",
        options: { branch: false },
        createSession: async () => ({ session }),
      }),
    ).rejects.toThrow("Question required but no answer was available (non_tty).");

    expect(unsubscribed).toBe(true);
    expect(disposed).toBe(true);
  });
});
