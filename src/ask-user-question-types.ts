import { Type, type Static } from "typebox";

export const ASK_USER_QUESTION_TOOL_NAME = "ask_user_question";

export const MAX_QUESTIONS = 4;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
export const MAX_HEADER_LENGTH = 16;
export const MAX_LABEL_LENGTH = 60;

export const OTHER_LABEL = "Other";
export const TYPE_SOMETHING_LABEL = "Type something.";
export const CHAT_ABOUT_THIS_LABEL = "Chat about this";
export const NEXT_QUESTION_LABEL = "Next question";
export const RESERVED_LABELS = [
  OTHER_LABEL,
  TYPE_SOMETHING_LABEL,
  CHAT_ABOUT_THIS_LABEL,
  NEXT_QUESTION_LABEL,
] as const;

export const askUserQuestionParameters = Type.Object(
  {
    questions: Type.Array(
      Type.Object(
        {
          question: Type.String({ minLength: 1 }),
          header: Type.String({ minLength: 1, maxLength: MAX_HEADER_LENGTH }),
          options: Type.Array(
            Type.Object(
              {
                label: Type.String({ minLength: 1, maxLength: MAX_LABEL_LENGTH }),
                description: Type.String({ minLength: 1 }),
                preview: Type.Optional(Type.String()),
              },
              { additionalProperties: false },
            ),
            { minItems: MIN_OPTIONS, maxItems: MAX_OPTIONS },
          ),
          multiSelect: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: MAX_QUESTIONS },
    ),
  },
  { additionalProperties: false },
);

export type AskUserQuestionInput = Static<typeof askUserQuestionParameters>;
export type AskUserQuestion = AskUserQuestionInput["questions"][number];
export type AskUserQuestionOption = AskUserQuestion["options"][number];

export type QuestionAnswer =
  | {
      readonly questionIndex: number;
      readonly question: string;
      readonly kind: "option";
      readonly answer: string;
      readonly preview?: string;
    }
  | {
      readonly questionIndex: number;
      readonly question: string;
      readonly kind: "custom";
      readonly answer: string | null;
    }
  | {
      readonly questionIndex: number;
      readonly question: string;
      readonly kind: "multi";
      readonly answer: null;
      readonly selected: readonly string[];
    };

export type AskUserQuestionResult =
  | {
      readonly status: "completed";
      readonly answers: readonly QuestionAnswer[];
      readonly pendingQuestions: readonly AskUserQuestion[];
    }
  | {
      readonly status: "cancelled";
      readonly reason: "non_tty" | "user_cancelled" | "input_closed" | "no_ui";
      readonly answers: readonly QuestionAnswer[];
      readonly pendingQuestions: readonly AskUserQuestion[];
      readonly error?: AskUserQuestionValidationError;
    }
  | {
      readonly status: "error";
      readonly errors: readonly string[];
      readonly pendingQuestions: readonly AskUserQuestion[];
      readonly error?: AskUserQuestionValidationError;
    };

export type AskUserQuestionValidationError =
  | "no_ui"
  | "no_questions"
  | "too_many_questions"
  | "too_few_options"
  | "too_many_options"
  | "empty_question"
  | "empty_header"
  | "empty_label"
  | "empty_description"
  | "duplicate_question"
  | "duplicate_option_label"
  | "reserved_label"
  | "preview_on_multiselect"
  | "invalid_params";
