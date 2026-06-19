import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import {
  askUserQuestions,
  createAskUserQuestionTool,
  createTerminalQuestionPromptAdapter,
  formatAskUserQuestionResultForModel,
  type AskUserQuestionInput,
  type QuestionPromptAdapter,
} from "./ask-user-question";

const singleQuestion = (overrides: Partial<AskUserQuestionInput["questions"][number]> = {}) => ({
  question: "How should these changes be grouped?",
  header: "Grouping",
  options: [
    { label: "Two commits", description: "Keeps independent changes revertible." },
    { label: "One commit", description: "Use only when changes are inseparable." },
  ],
  ...overrides,
});

function createMockAdapter(
  options: {
    readonly responses?: readonly (string | undefined)[];
    readonly interactive?: boolean;
  } = {},
): QuestionPromptAdapter & { readonly writes: string[]; readonly prompts: string[] } {
  const responses = [...(options.responses ?? [])];
  const writes: string[] = [];
  const prompts: string[] = [];

  return {
    writes,
    prompts,
    isInteractive: () => options.interactive ?? true,
    write: (text) => {
      writes.push(text);
    },
    readLine: async (prompt) => {
      prompts.push(prompt);
      return responses.shift();
    },
  };
}

describe("askUserQuestions", () => {
  test("returns a selected option answer", async () => {
    const adapter = createMockAdapter({ responses: ["1"] });

    const result = await askUserQuestions({ questions: [singleQuestion()] }, adapter);

    expect(result).toEqual({
      status: "answered",
      answers: [
        {
          questionIndex: 0,
          header: "Grouping",
          question: "How should these changes be grouped?",
          type: "options",
          selectedOptions: [
            {
              index: 1,
              label: "Two commits",
              description: "Keeps independent changes revertible.",
            },
          ],
        },
      ],
    });
    expect(adapter.writes.join("\n")).toContain("1. Two commits");
  });

  test("returns free-form text when the answer is not an option number", async () => {
    const adapter = createMockAdapter({ responses: ["Split docs separately"] });

    const result = await askUserQuestions({ questions: [singleQuestion()] }, adapter);

    expect(result).toEqual({
      status: "answered",
      answers: [
        {
          questionIndex: 0,
          header: "Grouping",
          question: "How should these changes be grouped?",
          type: "freeform",
          text: "Split docs separately",
        },
      ],
    });
  });

  test("supports multi-select option answers", async () => {
    const adapter = createMockAdapter({ responses: ["1,3"] });

    const result = await askUserQuestions(
      {
        questions: [
          singleQuestion({
            multiSelect: true,
            options: [
              { label: "Docs", description: "Commit documentation." },
              { label: "Tests", description: "Commit tests." },
              { label: "Tooling", description: "Commit tooling." },
            ],
          }),
        ],
      },
      adapter,
    );

    expect(result.status).toBe("answered");
    if (result.status !== "answered") {
      throw new Error("expected answered result");
    }
    expect(result.answers[0]).toMatchObject({
      type: "options",
      selectedOptions: [
        { index: 1, label: "Docs" },
        { index: 3, label: "Tooling" },
      ],
    });
  });

  test("cancels clearly without a TTY", async () => {
    const adapter = createMockAdapter({ interactive: false });

    const result = await askUserQuestions({ questions: [singleQuestion()] }, adapter);

    expect(result).toEqual({
      status: "cancelled",
      reason: "non_tty",
      answers: [],
      pendingQuestions: [singleQuestion()],
    });
  });

  test("keeps answered and pending questions on cancellation", async () => {
    const adapter = createMockAdapter({ responses: ["1", ""] });
    const secondQuestion = singleQuestion({ header: "Language", question: "Which language?" });

    const result = await askUserQuestions(
      { questions: [singleQuestion(), secondQuestion] },
      adapter,
    );

    expect(result.status).toBe("cancelled");
    if (result.status !== "cancelled") {
      throw new Error("expected cancelled result");
    }
    expect(result.reason).toBe("user_cancelled");
    expect(result.answers).toHaveLength(1);
    expect(result.pendingQuestions).toEqual([secondQuestion]);
  });

  test("formats invalid input for the model", () => {
    expect(formatAskUserQuestionResultForModel({ status: "error", errors: ["bad input"] })).toBe(
      "ask_user_question input was invalid:\n- bad input",
    );
  });
});

describe("createTerminalQuestionPromptAdapter", () => {
  test("returns undefined when input closes", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    Object.defineProperty(input, "isTTY", { value: true });
    Object.defineProperty(output, "isTTY", { value: true });
    const adapter = createTerminalQuestionPromptAdapter(
      input as unknown as NodeJS.ReadStream,
      output as unknown as NodeJS.WriteStream,
    );

    const answerPromise = adapter.readLine("Question? ");
    input.push(null);

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      answerPromise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("readLine timed out")), 500);
      }),
    ]);
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }

    expect(result).toBeUndefined();
  });
});

describe("createAskUserQuestionTool", () => {
  test("returns model-readable content and structured details", async () => {
    const adapter = createMockAdapter({ responses: ["2"] });
    const tool = createAskUserQuestionTool(adapter);

    const result = await tool.execute(
      "tool-call-1",
      { questions: [singleQuestion()] },
      undefined,
      undefined,
      {} as never,
    );

    expect(result.content).toEqual([
      {
        type: "text",
        text: "User answers:\n- Grouping: One commit",
      },
    ]);
    expect(result.details).toMatchObject({ status: "answered" });
  });
});
