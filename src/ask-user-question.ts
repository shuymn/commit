import { createInterface } from "node:readline/promises";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  ASK_USER_QUESTION_TOOL_NAME,
  askUserQuestionParameters,
  type AskUserQuestion,
  type AskUserQuestionInput,
  type AskUserQuestionResult,
  type AskUserQuestionValidationError,
  MAX_HEADER_LENGTH,
  MAX_LABEL_LENGTH,
  MAX_OPTIONS,
  MAX_QUESTIONS,
  MIN_OPTIONS,
  RESERVED_LABELS,
  type QuestionAnswer,
} from "./ask-user-question-types";
import { isObjectRecord } from "./tool-result";

export {
  ASK_USER_QUESTION_TOOL_NAME,
  askUserQuestionParameters,
  type AskUserQuestion,
  type AskUserQuestionInput,
  type AskUserQuestionOption,
  type AskUserQuestionResult,
  type QuestionAnswer,
} from "./ask-user-question-types";

export type QuestionPromptAdapter = {
  readonly isInteractive: () => boolean;
  readonly write: (text: string) => void | Promise<void>;
  readonly readLine: (prompt: string) => Promise<string | undefined>;
};

export type AskUserQuestionPresenter = (
  input: AskUserQuestionInput,
) => Promise<AskUserQuestionResult>;

export type CreateAskUserQuestionToolOptions = {
  readonly promptAdapter?: QuestionPromptAdapter;
  readonly presenter?: AskUserQuestionPresenter;
};

export type QuestionToolFailure =
  | { readonly status: "cancelled"; readonly reason: string; readonly error?: string }
  | { readonly status: "error"; readonly errors: readonly string[]; readonly error?: string };

type ValidationResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly error: AskUserQuestionValidationError;
      readonly message: string;
    };

const ROOT_KEYS = ["questions"] as const;
const QUESTION_KEYS = ["question", "header", "options", "multiSelect"] as const;
const OPTION_KEYS = ["label", "description", "preview"] as const;

export function toAskUserQuestionResult(details: unknown): QuestionToolFailure | undefined {
  if (!isObjectRecord(details) || typeof details.status !== "string") {
    return undefined;
  }

  if (details.status === "cancelled" && typeof details.reason === "string") {
    return {
      status: "cancelled",
      reason: details.reason,
      ...(typeof details.error === "string" ? { error: details.error } : {}),
    };
  }

  if (
    details.status === "error" &&
    Array.isArray(details.errors) &&
    details.errors.every((error): error is string => typeof error === "string")
  ) {
    return {
      status: "error",
      errors: details.errors,
      ...(typeof details.error === "string" ? { error: details.error } : {}),
    };
  }

  return undefined;
}

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
  return isObjectRecord(error) && error.name === "AbortError";
}

export async function askUserQuestions(
  input: AskUserQuestionInput,
  adapter: QuestionPromptAdapter = createTerminalQuestionPromptAdapter(),
): Promise<AskUserQuestionResult> {
  const validation = validateAskUserQuestionInput(input);
  if (!validation.ok) {
    return errorResult(input, validation.message, validation.error);
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

  return completedResult(answers);
}

export function createAskUserQuestionTool(
  optionsOrAdapter: CreateAskUserQuestionToolOptions | QuestionPromptAdapter = {},
) {
  const options =
    "isInteractive" in optionsOrAdapter ? { promptAdapter: optionsOrAdapter } : optionsOrAdapter;
  const promptAdapter = options.promptAdapter ?? createTerminalQuestionPromptAdapter();

  return defineTool({
    name: ASK_USER_QUESTION_TOOL_NAME,
    label: "Ask User Question",
    description:
      "Ask the user bounded structured questions with listed options, optional multi-select, and custom-answer fallback.",
    promptSnippet:
      "Ask the user up to 4 structured questions when implementation-relevant requirements or decisions are ambiguous",
    promptGuidelines: [
      "Use ask_user_question only when ambiguity materially affects implementation, architecture, scope, data loss, or user-visible behavior.",
      "Each question must have 2-4 options. Each option must have a concise label and a description explaining the trade-off.",
      "Use multiSelect: true only when multiple listed answers can be valid.",
      "Option previews are supported only for single-select questions.",
      "If you recommend a specific option, make it the first option and append '(Recommended)' to the label.",
    ],
    parameters: askUserQuestionParameters,
    executionMode: "sequential",
    execute: async (_toolCallId, params) => {
      const result =
        options.presenter !== undefined
          ? await options.presenter(params)
          : await askUserQuestions(params, promptAdapter);
      return {
        content: [{ type: "text", text: formatAskUserQuestionResultForModel(result) }],
        details: result,
        terminate: result.status !== "completed" ? true : undefined,
      };
    },
    renderCall(args, theme) {
      const questions = Array.isArray((args as Partial<AskUserQuestionInput>).questions)
        ? ((args as Partial<AskUserQuestionInput>).questions ?? [])
        : [];
      const labels = questions.map((question) => question.header || question.question).join(", ");
      return new Text(
        theme.fg("toolTitle", theme.bold("ask_user_question ")) +
          theme.fg("muted", `${questions.length} question${questions.length === 1 ? "" : "s"}`) +
          (labels ? theme.fg("dim", ` (${labels})`) : ""),
        0,
        0,
      );
    },
    renderResult(result, _options, theme) {
      const details = result.details as AskUserQuestionResult | undefined;
      if (details === undefined) {
        const first = result.content[0];
        return new Text(first?.type === "text" ? first.text : "", 0, 0);
      }

      if (details.status === "cancelled") {
        const suffix = details.error !== undefined ? ` (${details.error})` : "";
        return new Text(theme.fg("warning", `Cancelled${suffix}`), 0, 0);
      }

      if (details.status === "error") {
        const suffix = details.error !== undefined ? ` (${details.error})` : "";
        return new Text(theme.fg("error", `Invalid question${suffix}`), 0, 0);
      }

      const lines = details.answers.map((answer) => {
        const value =
          answer.kind === "multi" ? answer.selected.join(", ") : (answer.answer ?? "(no response)");
        return `${theme.fg("success", "✓")} Q${answer.questionIndex + 1}: ${theme.fg("accent", value)}`;
      });
      return new Text(lines.join("\n"), 0, 0);
    },
  });
}

export function validateAskUserQuestionInput(input: unknown): ValidationResult {
  if (!isObjectRecord(input) || !Array.isArray(input.questions)) {
    return invalidParams("Invalid ask_user_question parameters: questions must be an array.");
  }
  if (!hasOnlyKeys(input, ROOT_KEYS)) {
    return invalidParams("Invalid ask_user_question parameters: unknown root property.");
  }

  const typed = input as AskUserQuestionInput;
  if (typed.questions.length === 0) {
    return { ok: false, error: "no_questions", message: "At least one question is required." };
  }
  if (typed.questions.length > MAX_QUESTIONS) {
    return {
      ok: false,
      error: "too_many_questions",
      message: `At most ${MAX_QUESTIONS} questions are allowed.`,
    };
  }

  const seenQuestions = new Set<string>();
  const reserved = new Set(RESERVED_LABELS.map(normalizeComparable));

  for (const [questionIndex, question] of typed.questions.entries()) {
    if (!isObjectRecord(question)) {
      return invalidParams(
        "Invalid ask_user_question parameters: each question must be an object.",
      );
    }
    if (!hasOnlyKeys(question, QUESTION_KEYS)) {
      return invalidParams(
        `Invalid ask_user_question parameters: questions[${questionIndex}] contains unknown properties.`,
      );
    }
    if (typeof question.question !== "string" || typeof question.header !== "string") {
      return invalidParams(
        "Invalid ask_user_question parameters: question and header must be strings.",
      );
    }
    if (question.question.trim().length === 0) {
      return {
        ok: false,
        error: "empty_question",
        message: `questions[${questionIndex}].question must not be empty.`,
      };
    }
    if (question.header.trim().length === 0) {
      return {
        ok: false,
        error: "empty_header",
        message: `questions[${questionIndex}].header must not be empty.`,
      };
    }
    if (question.header.length > MAX_HEADER_LENGTH) {
      return invalidParams(
        `questions[${questionIndex}].header must be at most ${MAX_HEADER_LENGTH} characters.`,
      );
    }
    if (!Array.isArray(question.options)) {
      return invalidParams("Invalid ask_user_question parameters: options must be an array.");
    }
    if (question.multiSelect !== undefined && typeof question.multiSelect !== "boolean") {
      return invalidParams(
        "Invalid ask_user_question parameters: multiSelect must be a boolean when provided.",
      );
    }

    const questionKey = normalizeComparable(question.question);
    if (seenQuestions.has(questionKey)) {
      return {
        ok: false,
        error: "duplicate_question",
        message: `Duplicate question: ${question.question}`,
      };
    }
    seenQuestions.add(questionKey);

    if (question.options.length < MIN_OPTIONS) {
      return {
        ok: false,
        error: "too_few_options",
        message: `Question "${question.header}" must have at least ${MIN_OPTIONS} options.`,
      };
    }
    if (question.options.length > MAX_OPTIONS) {
      return {
        ok: false,
        error: "too_many_options",
        message: `Question "${question.header}" must have at most ${MAX_OPTIONS} options.`,
      };
    }

    const seenOptionLabels = new Set<string>();
    for (const [optionIndex, option] of question.options.entries()) {
      if (!isObjectRecord(option)) {
        return invalidParams(
          "Invalid ask_user_question parameters: each option must be an object.",
        );
      }
      if (!hasOnlyKeys(option, OPTION_KEYS)) {
        return invalidParams(
          `Invalid ask_user_question parameters: questions[${questionIndex}].options[${optionIndex}] contains unknown properties.`,
        );
      }
      if (typeof option.label !== "string" || typeof option.description !== "string") {
        return invalidParams(
          "Invalid ask_user_question parameters: option label and description must be strings.",
        );
      }
      if (option.preview !== undefined && typeof option.preview !== "string") {
        return invalidParams(
          "Invalid ask_user_question parameters: option preview must be a string when provided.",
        );
      }

      const labelKey = normalizeComparable(option.label);
      if (option.label.trim().length === 0) {
        return {
          ok: false,
          error: "empty_label",
          message: `questions[${questionIndex}].options[${optionIndex}].label must not be empty.`,
        };
      }
      if (option.label.length > MAX_LABEL_LENGTH) {
        return invalidParams(
          `questions[${questionIndex}].options[${optionIndex}].label must be at most ${MAX_LABEL_LENGTH} characters.`,
        );
      }
      if (reserved.has(labelKey)) {
        return {
          ok: false,
          error: "reserved_label",
          message: `Option label "${option.label}" is reserved for runtime controls.`,
        };
      }
      if (seenOptionLabels.has(labelKey)) {
        return {
          ok: false,
          error: "duplicate_option_label",
          message: `Duplicate option label in "${question.header}": ${option.label}`,
        };
      }
      seenOptionLabels.add(labelKey);

      if (option.description.trim().length === 0) {
        return {
          ok: false,
          error: "empty_description",
          message: `Option "${option.label}" must include a non-empty description.`,
        };
      }
      if (question.multiSelect === true && option.preview?.trim()) {
        return {
          ok: false,
          error: "preview_on_multiselect",
          message: `Option previews are supported only for single-select questions: ${option.label}`,
        };
      }
    }
  }

  return { ok: true };
}

export function formatAskUserQuestionResultForModel(result: AskUserQuestionResult): string {
  if (result.status === "error") {
    return `ask_user_question input was invalid:\n${result.errors.map((error) => `- ${error}`).join("\n")}`;
  }

  if (result.status === "cancelled") {
    return [
      "The user cancelled the questionnaire. Do not assume an answer.",
      result.answers.length > 0 ? formatAnswers(result.answers) : undefined,
      result.pendingQuestions.length > 0
        ? `Pending questions: ${result.pendingQuestions.map((question) => question.header).join(", ")}`
        : undefined,
    ]
      .filter((line) => line !== undefined)
      .join("\n");
  }

  return `Questionnaire completed.\n${formatAnswers(result.answers)}`;
}

export function completedResult(answers: readonly QuestionAnswer[]): AskUserQuestionResult {
  return {
    status: "completed",
    answers,
    pendingQuestions: [],
  };
}

export function cancelledResult(
  input: AskUserQuestionInput,
  answers: readonly QuestionAnswer[] = [],
): AskUserQuestionResult {
  return {
    status: "cancelled",
    reason: "user_cancelled",
    answers,
    pendingQuestions: pendingQuestionsFrom(input, answers),
  };
}

function errorResult(
  input: unknown,
  message: string,
  error: AskUserQuestionValidationError,
): AskUserQuestionResult {
  return {
    status: "error",
    errors: [message],
    pendingQuestions: safePendingQuestions(input),
    error,
  };
}

function pendingQuestionsFrom(
  input: AskUserQuestionInput,
  answers: readonly QuestionAnswer[],
): AskUserQuestion[] {
  const answered = new Set(answers.map((answer) => answer.questionIndex));
  return input.questions.filter((_question, index) => !answered.has(index));
}

export function safePendingQuestions(input: unknown): AskUserQuestion[] {
  if (!isObjectRecord(input) || !Array.isArray(input.questions)) {
    return [];
  }
  return input.questions
    .map(sanitizePendingQuestion)
    .filter((question): question is AskUserQuestion => question !== undefined);
}

function sanitizePendingQuestion(value: unknown): AskUserQuestion | undefined {
  if (
    !isObjectRecord(value) ||
    typeof value.question !== "string" ||
    typeof value.header !== "string" ||
    !Array.isArray(value.options) ||
    (value.multiSelect !== undefined && typeof value.multiSelect !== "boolean")
  ) {
    return undefined;
  }

  const options = value.options.map(sanitizePendingOption);
  if (options.some((option) => option === undefined)) {
    return undefined;
  }

  return {
    question: value.question,
    header: value.header,
    options: options as AskUserQuestion["options"],
    ...(value.multiSelect !== undefined ? { multiSelect: value.multiSelect } : {}),
  };
}

function sanitizePendingOption(value: unknown): AskUserQuestion["options"][number] | undefined {
  if (
    !isObjectRecord(value) ||
    typeof value.label !== "string" ||
    typeof value.description !== "string" ||
    (value.preview !== undefined && typeof value.preview !== "string")
  ) {
    return undefined;
  }

  return {
    label: value.label,
    description: value.description,
    ...(value.preview !== undefined ? { preview: value.preview } : {}),
  };
}

function formatAnswers(answers: readonly QuestionAnswer[]): string {
  if (answers.length === 0) {
    return "No answers were provided.";
  }

  return answers
    .map((answer) => {
      const label = `Q${answer.questionIndex + 1}`;
      if (answer.kind === "multi") {
        return `${label}: User selected: ${answer.selected.join(", ")}`;
      }
      if (answer.kind === "custom") {
        return `${label}: User wrote: ${answer.answer ?? "(no response)"}`;
      }
      return `${label}: User selected: ${answer.answer}`;
    })
    .join("\n");
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
        ? "Select option numbers separated by commas, or press Enter to cancel: "
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
      if (question.multiSelect === true) {
        return {
          status: "answered",
          answer: {
            questionIndex: index,
            question: question.question,
            kind: "multi",
            answer: null,
            selected: selectedIndexes.indexes.map((optionIndex) => {
              const option = question.options[optionIndex];
              if (option === undefined) {
                throw new Error(`Internal option index out of range: ${optionIndex}`);
              }
              return option.label;
            }),
          },
        };
      }

      const option = question.options[selectedIndexes.indexes[0] ?? -1];
      if (option === undefined) {
        throw new Error("Internal option index out of range.");
      }
      return {
        status: "answered",
        answer: {
          questionIndex: index,
          question: question.question,
          kind: "option",
          answer: option.label,
          ...(option.preview ? { preview: option.preview } : {}),
        },
      };
    }

    if (question.multiSelect === true) {
      await adapter.write("Choose listed option numbers for multi-select questions.\n");
      continue;
    }

    return {
      status: "answered",
      answer: {
        questionIndex: index,
        question: question.question,
        kind: "custom",
        answer: trimmed,
      },
    };
  }
}

function formatQuestion(question: AskUserQuestion, index: number, total: number): string {
  const heading = total > 1 ? `Question ${index + 1}/${total}` : "Question";
  const lines = [`\n${heading} [${question.header}] ${question.question}`];

  question.options.forEach((option, optionIndex) => {
    lines.push(`  ${optionIndex + 1}. ${option.label} - ${option.description}`);
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

function normalizeComparable(value: string): string {
  return value.trim().toLowerCase();
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function invalidParams(message: string): ValidationResult {
  return { ok: false, error: "invalid_params", message };
}
