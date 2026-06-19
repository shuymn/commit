import { createInterface } from "node:readline/promises";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

export const ASK_USER_QUESTION_TOOL_NAME = "ask_user_question";

export const askUserQuestionParameters = Type.Object(
  {
    questions: Type.Array(
      Type.Object(
        {
          question: Type.String({ minLength: 1 }),
          header: Type.String({ minLength: 1, maxLength: 16 }),
          options: Type.Array(
            Type.Object(
              {
                label: Type.String({ minLength: 1, maxLength: 60 }),
                description: Type.String({ minLength: 1 }),
                preview: Type.Optional(Type.String()),
              },
              { additionalProperties: false },
            ),
            { minItems: 2, maxItems: 4 },
          ),
          multiSelect: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 4 },
    ),
  },
  { additionalProperties: false },
);

export type AskUserQuestionInput = Static<typeof askUserQuestionParameters>;
export type AskUserQuestion = AskUserQuestionInput["questions"][number];
export type AskUserQuestionOption = AskUserQuestion["options"][number];

export type QuestionPromptAdapter = {
  readonly isInteractive: () => boolean;
  readonly write: (text: string) => void | Promise<void>;
  readonly readLine: (prompt: string) => Promise<string | undefined>;
};

export type SelectedQuestionOption = {
  readonly index: number;
  readonly label: string;
  readonly description: string;
};

export type QuestionAnswer =
  | {
      readonly questionIndex: number;
      readonly header: string;
      readonly question: string;
      readonly type: "options";
      readonly selectedOptions: readonly SelectedQuestionOption[];
    }
  | {
      readonly questionIndex: number;
      readonly header: string;
      readonly question: string;
      readonly type: "freeform";
      readonly text: string;
    };

export type AskUserQuestionResult =
  | {
      readonly status: "answered";
      readonly answers: readonly QuestionAnswer[];
    }
  | {
      readonly status: "cancelled";
      readonly reason: "non_tty" | "user_cancelled" | "input_closed";
      readonly answers: readonly QuestionAnswer[];
      readonly pendingQuestions: readonly AskUserQuestion[];
    }
  | {
      readonly status: "error";
      readonly errors: readonly string[];
    };

export function createTerminalQuestionPromptAdapter(
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout,
): QuestionPromptAdapter {
  return {
    isInteractive: () => input.isTTY === true && output.isTTY === true,
    write: (text) => {
      output.write(text);
    },
    readLine: async (prompt) => {
      const readline = createInterface({ input, output });
      let settled = false;
      try {
        return await new Promise<string | undefined>((resolve, reject) => {
          const resolveOnce = (answer: string | undefined) => {
            if (settled) {
              return;
            }
            settled = true;
            readline.off("close", onClose);
            resolve(answer);
          };
          const rejectOnce = (error: unknown) => {
            if (settled) {
              return;
            }
            settled = true;
            readline.off("close", onClose);
            reject(error);
          };
          const onClose = () => {
            resolveOnce(undefined);
          };

          readline.once("close", onClose);
          readline.question(prompt).then(resolveOnce, (error) => {
            if (isInputClosedError(error)) {
              resolveOnce(undefined);
              return;
            }
            rejectOnce(error);
          });
        });
      } finally {
        readline.close();
      }
    },
  };
}

function isInputClosedError(error: unknown): boolean {
  return (
    error instanceof Error && (error.name === "AbortError" || /closed|eof/i.test(error.message))
  );
}

export async function askUserQuestions(
  input: AskUserQuestionInput,
  adapter: QuestionPromptAdapter = createTerminalQuestionPromptAdapter(),
): Promise<AskUserQuestionResult> {
  const errors = validateAskUserQuestionInput(input);
  if (errors.length > 0) {
    return { status: "error", errors };
  }

  if (!adapter.isInteractive()) {
    return {
      status: "cancelled",
      reason: "non_tty",
      answers: [],
      pendingQuestions: input.questions,
    };
  }

  const answers: QuestionAnswer[] = [];
  for (const [index, question] of input.questions.entries()) {
    const answer = await askSingleQuestion(question, index, input.questions.length, adapter);
    if (answer.status === "cancelled") {
      return {
        status: "cancelled",
        reason: answer.reason,
        answers,
        pendingQuestions: input.questions.slice(index),
      };
    }
    answers.push(answer.answer);
  }

  return { status: "answered", answers };
}

export function createAskUserQuestionTool(
  adapter: QuestionPromptAdapter = createTerminalQuestionPromptAdapter(),
) {
  return defineTool({
    name: ASK_USER_QUESTION_TOOL_NAME,
    label: "Ask User",
    description:
      "Ask the user bounded questions with listed options, optional multi-select, and free-form fallback.",
    parameters: askUserQuestionParameters,
    executionMode: "sequential",
    execute: async (_toolCallId, params) => {
      const result = await askUserQuestions(params, adapter);
      return {
        content: [{ type: "text", text: formatAskUserQuestionResultForModel(result) }],
        details: result,
        terminate: result.status !== "answered" ? true : undefined,
      };
    },
  });
}

export function validateAskUserQuestionInput(input: AskUserQuestionInput): string[] {
  const errors: string[] = [];

  if (!Array.isArray(input.questions) || input.questions.length < 1 || input.questions.length > 4) {
    errors.push("questions must contain between 1 and 4 items.");
    return errors;
  }

  input.questions.forEach((question, questionIndex) => {
    const prefix = `questions[${questionIndex}]`;
    if (question.question.trim().length === 0) {
      errors.push(`${prefix}.question must not be empty.`);
    }
    if (question.header.trim().length === 0 || question.header.length > 16) {
      errors.push(`${prefix}.header must be 1-16 characters.`);
    }
    if (question.options.length < 2 || question.options.length > 4) {
      errors.push(`${prefix}.options must contain between 2 and 4 items.`);
    }
    question.options.forEach((option, optionIndex) => {
      const optionPrefix = `${prefix}.options[${optionIndex}]`;
      if (option.label.trim().length === 0 || option.label.length > 60) {
        errors.push(`${optionPrefix}.label must be 1-60 characters.`);
      }
      if (option.description.trim().length === 0) {
        errors.push(`${optionPrefix}.description must not be empty.`);
      }
    });
  });

  return errors;
}

export function formatAskUserQuestionResultForModel(result: AskUserQuestionResult): string {
  if (result.status === "error") {
    return `${ASK_USER_QUESTION_TOOL_NAME} input was invalid:\n${result.errors.map((error) => `- ${error}`).join("\n")}`;
  }

  if (result.status === "cancelled") {
    return [
      `${ASK_USER_QUESTION_TOOL_NAME} could not get an answer: ${result.reason}.`,
      result.answers.length > 0 ? formatAnswers(result.answers) : undefined,
      result.pendingQuestions.length > 0
        ? `Pending questions: ${result.pendingQuestions.map((question) => question.header).join(", ")}`
        : undefined,
    ]
      .filter((line) => line !== undefined)
      .join("\n");
  }

  return formatAnswers(result.answers);
}

function formatAnswers(answers: readonly QuestionAnswer[]): string {
  const lines = ["User answers:"];
  for (const answer of answers) {
    if (answer.type === "freeform") {
      lines.push(`- ${answer.header}: ${answer.text}`);
      continue;
    }

    lines.push(
      `- ${answer.header}: ${answer.selectedOptions.map((option) => option.label).join(", ")}`,
    );
  }
  return lines.join("\n");
}

async function askSingleQuestion(
  question: AskUserQuestion,
  index: number,
  total: number,
  adapter: QuestionPromptAdapter,
): Promise<
  | { readonly status: "answered"; readonly answer: QuestionAnswer }
  | { readonly status: "cancelled"; readonly reason: "user_cancelled" | "input_closed" }
> {
  await adapter.write(formatQuestion(question, index, total));

  while (true) {
    const response = await adapter.readLine(
      question.multiSelect === true
        ? "Select option numbers separated by commas, type a custom answer, or press Enter to cancel: "
        : "Select an option number, type a custom answer, or press Enter to cancel: ",
    );

    if (response === undefined) {
      return { status: "cancelled", reason: "input_closed" };
    }

    const trimmed = response.trim();
    if (
      trimmed.length === 0 ||
      trimmed.toLowerCase() === "cancel" ||
      trimmed.toLowerCase() === "q"
    ) {
      return { status: "cancelled", reason: "user_cancelled" };
    }

    const selectedIndexes = parseSelectedIndexes(
      trimmed,
      question.options.length,
      question.multiSelect === true,
    );
    if (selectedIndexes.status === "invalid") {
      await adapter.write(`${selectedIndexes.message}\n`);
      continue;
    }

    if (selectedIndexes.status === "selected") {
      return {
        status: "answered",
        answer: {
          questionIndex: index,
          header: question.header,
          question: question.question,
          type: "options",
          selectedOptions: selectedIndexes.indexes.map((optionIndex) => {
            const option = question.options[optionIndex];
            if (option === undefined) {
              throw new Error(`Internal option index out of range: ${optionIndex}`);
            }
            return {
              index: optionIndex + 1,
              label: option.label,
              description: option.description,
            };
          }),
        },
      };
    }

    return {
      status: "answered",
      answer: {
        questionIndex: index,
        header: question.header,
        question: question.question,
        type: "freeform",
        text: trimmed,
      },
    };
  }
}

function formatQuestion(question: AskUserQuestion, index: number, total: number): string {
  const heading = total > 1 ? `Question ${index + 1}/${total}` : "Question";
  const lines = [`\n${heading} [${question.header}] ${question.question}`];

  question.options.forEach((option, optionIndex) => {
    lines.push(`  ${optionIndex + 1}. ${option.label} — ${option.description}`);
    if (option.preview !== undefined && option.preview.trim().length > 0) {
      lines.push(indentPreview(option.preview));
    }
  });

  return `${lines.join("\n")}\n`;
}

function indentPreview(preview: string): string {
  return preview
    .split(/\r?\n/)
    .map((line) => `     ${line}`)
    .join("\n");
}

function parseSelectedIndexes(
  text: string,
  optionCount: number,
  multiSelect: boolean,
):
  | { readonly status: "selected"; readonly indexes: readonly number[] }
  | { readonly status: "freeform" }
  | { readonly status: "invalid"; readonly message: string } {
  const parts = multiSelect ? text.split(",").map((part) => part.trim()) : [text];
  const nonEmptyParts = parts.filter((part) => part.length > 0);

  if (nonEmptyParts.length === 0 || !nonEmptyParts.every((part) => /^\d+$/.test(part))) {
    return { status: "freeform" };
  }

  if (!multiSelect && nonEmptyParts.length !== 1) {
    return { status: "invalid", message: "Choose exactly one option." };
  }

  const indexes = nonEmptyParts.map((part) => Number.parseInt(part, 10) - 1);
  if (indexes.some((optionIndex) => optionIndex < 0 || optionIndex >= optionCount)) {
    return { status: "invalid", message: `Choose option numbers between 1 and ${optionCount}.` };
  }

  return { status: "selected", indexes: Array.from(new Set(indexes)) };
}
