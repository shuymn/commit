import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import {
  askUserQuestions,
  createAskUserQuestionTool,
  createTerminalQuestionPromptAdapter,
  formatAskUserQuestionResultForModel,
  toAskUserQuestionResult,
  type AskUserQuestionInput,
  type QuestionPromptAdapter,
} from "./ask-user-question";
import { createQuestionnaireComponent, printableInput } from "./ask-user-question-ui";

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
      status: "completed",
      answers: [
        {
          questionIndex: 0,
          question: "How should these changes be grouped?",
          kind: "option",
          answer: "Two commits",
        },
      ],
      pendingQuestions: [],
    });
    expect(adapter.writes.join("\n")).toContain("1. Two commits");
  });

  test("returns free-form text when the answer is not an option number", async () => {
    const adapter = createMockAdapter({ responses: ["Split docs separately"] });

    const result = await askUserQuestions({ questions: [singleQuestion()] }, adapter);

    expect(result).toEqual({
      status: "completed",
      answers: [
        {
          questionIndex: 0,
          question: "How should these changes be grouped?",
          kind: "custom",
          answer: "Split docs separately",
        },
      ],
      pendingQuestions: [],
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

    expect(result.status).toBe("completed");
    if (result.status !== "completed") {
      throw new Error("expected completed result");
    }
    expect(result.answers[0]).toMatchObject({
      kind: "multi",
      selected: ["Docs", "Tooling"],
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
    expect(
      formatAskUserQuestionResultForModel({
        status: "error",
        errors: ["bad input"],
        pendingQuestions: [],
      }),
    ).toBe("ask_user_question input was invalid:\n- bad input");
  });

  test("rejects whitespace-only schema strings", async () => {
    const result = await askUserQuestions(
      {
        questions: [
          singleQuestion({
            question: " ",
            header: "\t",
            options: [
              { label: " ", description: "Keeps independent changes revertible." },
              { label: "One commit", description: "\n" },
            ],
          }),
        ],
      },
      createMockAdapter(),
    );

    expect(result).toEqual({
      status: "error",
      errors: ["questions[0].question must not be empty."],
      pendingQuestions: [
        {
          question: " ",
          header: "\t",
          options: [
            { label: " ", description: "Keeps independent changes revertible." },
            { label: "One commit", description: "\n" },
          ],
        },
      ],
      error: "empty_question",
    });
  });

  test("rejects reserved labels, duplicate labels, empty descriptions, and previews on multi-select", async () => {
    await expect(
      askUserQuestions(
        {
          questions: [
            singleQuestion({
              options: [
                { label: "Type something.", description: "Reserved runtime row." },
                { label: "One commit", description: "Use only when changes are inseparable." },
              ],
            }),
          ],
        },
        createMockAdapter(),
      ),
    ).resolves.toMatchObject({ status: "error", error: "reserved_label" });

    await expect(
      askUserQuestions(
        {
          questions: [
            singleQuestion({
              options: [
                { label: "Same", description: "First." },
                { label: "same", description: "Duplicate." },
              ],
            }),
          ],
        },
        createMockAdapter(),
      ),
    ).resolves.toMatchObject({ status: "error", error: "duplicate_option_label" });

    await expect(
      askUserQuestions(
        {
          questions: [
            singleQuestion({
              options: [
                { label: "A", description: "" },
                { label: "B", description: "Valid." },
              ],
            }),
          ],
        },
        createMockAdapter(),
      ),
    ).resolves.toMatchObject({ status: "error", error: "empty_description" });

    await expect(
      askUserQuestions(
        {
          questions: [
            singleQuestion({
              multiSelect: true,
              options: [
                { label: "A", description: "Valid.", preview: "not allowed" },
                { label: "B", description: "Valid." },
              ],
            }),
          ],
        },
        createMockAdapter(),
      ),
    ).resolves.toMatchObject({ status: "error", error: "preview_on_multiselect" });
  });

  test("rejects schema-boundary drift for direct callers", async () => {
    await expect(
      askUserQuestions(
        {
          questions: [singleQuestion({ header: "Grouping question" })],
        },
        createMockAdapter(),
      ),
    ).resolves.toMatchObject({ status: "error", error: "invalid_params" });

    await expect(
      askUserQuestions(
        {
          questions: [
            singleQuestion({
              options: [
                { label: "x".repeat(61), description: "Too long." },
                { label: "B", description: "Valid." },
              ],
            }),
          ],
        },
        createMockAdapter(),
      ),
    ).resolves.toMatchObject({ status: "error", error: "invalid_params" });

    await expect(
      askUserQuestions(
        {
          questions: [
            {
              ...singleQuestion(),
              unexpected: true,
            },
          ],
        } as unknown as AskUserQuestionInput,
        createMockAdapter(),
      ),
    ).resolves.toMatchObject({ status: "error", error: "invalid_params" });
  });

  test("omits malformed pending questions from invalid input details", async () => {
    const result = await askUserQuestions(
      {
        questions: [
          {
            question: "Malformed options?",
            header: "Malformed",
            options: [null, { label: "B", description: "Valid." }],
          },
        ],
      } as unknown as AskUserQuestionInput,
      createMockAdapter(),
    );

    expect(result).toMatchObject({ status: "error", error: "invalid_params" });
    expect(result.pendingQuestions).toEqual([]);
  });
});

describe("toAskUserQuestionResult", () => {
  test("narrows cancelled and error details by the fields read by consumers", () => {
    expect(toAskUserQuestionResult({ status: "cancelled", reason: "non_tty" })).toMatchObject({
      status: "cancelled",
      reason: "non_tty",
    });
    expect(toAskUserQuestionResult({ status: "error", errors: ["bad input"] })).toEqual({
      status: "error",
      errors: ["bad input"],
    });
  });

  test("rejects malformed details", () => {
    expect(toAskUserQuestionResult({ status: "cancelled" })).toBeUndefined();
    expect(toAskUserQuestionResult({ status: "error", errors: [123] })).toBeUndefined();
    expect(toAskUserQuestionResult({ status: "unknown" })).toBeUndefined();
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
        text: "Questionnaire completed.\nQ1: User selected: One commit",
      },
    ]);
    expect(result.details).toMatchObject({ status: "completed" });
  });
});

describe("printableInput", () => {
  test("decodes protocol printable keys and bracketed paste controls", () => {
    expect(printableInput("\x1b[97u")).toBe("a");
    expect(printableInput("\x1b[27;1;97~")).toBe("a");
    expect(printableInput("\x1b[200~one\x1b[106;5utwo\x1b[201~")).toBe("onetwo");
  });
});

describe("createQuestionnaireComponent", () => {
  const theme = {
    fg: (_name: string, text: string) => text,
    bold: (text: string) => text,
  };

  function createHarness(input: AskUserQuestionInput = { questions: [singleQuestion()] }) {
    let result: unknown;
    let renderCount = 0;
    const component = createQuestionnaireComponent(
      input,
      { requestRender: () => renderCount++ },
      theme,
      { matches: (data, id) => data === id },
      (value) => {
        result = value;
      },
    );
    return {
      component,
      get result() {
        return result;
      },
      get renderCount() {
        return renderCount;
      },
    };
  }

  test("completes single-select through the summary screen", () => {
    const harness = createHarness();

    harness.component.handleInput("tui.select.confirm");
    expect(harness.component.render(80)).toContain("Ready to submit");
    expect(harness.result).toBeUndefined();

    harness.component.handleInput("tui.select.confirm");
    expect(harness.result).toEqual({
      status: "completed",
      answers: [
        {
          questionIndex: 0,
          question: "How should these changes be grouped?",
          kind: "option",
          answer: "Two commits",
        },
      ],
    });
  });

  test("supports custom answers and omits Chat about this", () => {
    const harness = createHarness();

    expect(harness.component.render(80).join("\n")).not.toContain("Chat about this");
    harness.component.handleInput("tui.select.down");
    harness.component.handleInput("tui.select.down");
    harness.component.handleInput("tui.select.confirm");
    harness.component.handleInput("Split docs");
    harness.component.handleInput("\r");
    harness.component.handleInput("tui.select.confirm");

    expect(harness.result).toEqual({
      status: "completed",
      answers: [
        {
          questionIndex: 0,
          question: "How should these changes be grouped?",
          kind: "custom",
          answer: "Split docs",
        },
      ],
    });
  });

  test("supports multi-select with required selection and ordered answers", () => {
    const harness = createHarness({
      questions: [
        singleQuestion({
          multiSelect: true,
          options: [
            { label: "Docs", description: "Commit documentation." },
            { label: "Tests", description: "Commit tests." },
          ],
        }),
      ],
    });

    harness.component.handleInput("tui.select.down");
    harness.component.handleInput("tui.select.down");
    harness.component.handleInput("tui.select.confirm");
    expect(harness.component.render(80)).toContain("Select at least one option before continuing.");

    harness.component.handleInput("tui.select.up");
    harness.component.handleInput(" ");
    harness.component.handleInput("tui.select.up");
    harness.component.handleInput(" ");
    harness.component.handleInput("tui.select.down");
    harness.component.handleInput("tui.select.down");
    harness.component.handleInput("tui.select.confirm");
    harness.component.handleInput("tui.select.confirm");

    expect(harness.result).toEqual({
      status: "completed",
      answers: [
        {
          questionIndex: 0,
          question: "How should these changes be grouped?",
          kind: "multi",
          answer: null,
          selected: ["Docs", "Tests"],
        },
      ],
    });
  });

  test("cancels from select and summary states", () => {
    const selectHarness = createHarness();
    selectHarness.component.handleInput("tui.select.cancel");
    expect(selectHarness.result).toEqual({ status: "cancelled", answers: [] });

    const summaryHarness = createHarness();
    summaryHarness.component.handleInput("tui.select.confirm");
    summaryHarness.component.handleInput("tui.select.cancel");
    expect(summaryHarness.result).toMatchObject({
      status: "cancelled",
      answers: [{ kind: "option", answer: "Two commits" }],
    });
  });

  test("forced cancellation preserves completed answers", () => {
    const harness = createHarness({
      questions: [
        singleQuestion(),
        singleQuestion({ header: "Language", question: "Which language?" }),
      ],
    });

    harness.component.handleInput("tui.select.confirm");
    harness.component.cancel();

    expect(harness.result).toMatchObject({
      status: "cancelled",
      answers: [{ kind: "option", answer: "Two commits" }],
    });
  });
});
