import {
  type AskUserQuestionInput,
  NEXT_QUESTION_LABEL,
  type QuestionAnswer,
  TYPE_SOMETHING_LABEL,
} from "./ask-user-question-types";

export type AskUiResult =
  | { readonly status: "completed"; readonly answers: readonly QuestionAnswer[] }
  | { readonly status: "cancelled"; readonly answers: readonly QuestionAnswer[] };

export type QuestionnaireMode = "select" | "custom" | "summary";

export type QuestionnaireAction =
  | { readonly type: "move"; readonly delta: -1 | 1 }
  | { readonly type: "confirm" }
  | { readonly type: "cancel" }
  | { readonly type: "toggle" }
  | { readonly type: "appendInput"; readonly text: string }
  | { readonly type: "backspace" };

export type QuestionnaireState = {
  readonly params: AskUserQuestionInput;
  questionIndex: number;
  selectedIndex: number;
  mode: QuestionnaireMode;
  inputDraft: string;
  notice?: string;
  answers: QuestionAnswer[];
  selectedMultiIndexes: Set<number>;
};

export type QuestionnaireSnapshot = {
  readonly params: AskUserQuestionInput;
  readonly questionIndex: number;
  readonly questionCount: number;
  readonly selectedIndex: number;
  readonly mode: QuestionnaireMode;
  readonly inputDraft: string;
  readonly notice?: string;
  readonly answers: readonly QuestionAnswer[];
  readonly currentQuestion: AskUserQuestionInput["questions"][number] | undefined;
  readonly selectedMultiIndexes: ReadonlySet<number>;
};

export type QuestionnaireUpdateResult = {
  readonly changed: boolean;
  readonly terminal?: AskUiResult;
};

export function createQuestionnaireState(params: AskUserQuestionInput): QuestionnaireState {
  return {
    params,
    questionIndex: 0,
    selectedIndex: 0,
    mode: "select",
    inputDraft: "",
    answers: [],
    selectedMultiIndexes: new Set(),
  };
}

export function questionnaireSnapshot(state: QuestionnaireState): QuestionnaireSnapshot {
  return {
    params: state.params,
    questionIndex: state.questionIndex,
    questionCount: state.params.questions.length,
    selectedIndex: state.selectedIndex,
    mode: state.mode,
    inputDraft: state.inputDraft,
    notice: state.notice,
    answers: [...state.answers],
    currentQuestion: currentQuestion(state),
    selectedMultiIndexes: new Set(state.selectedMultiIndexes),
  };
}

export function questionnaireItemCount(state: QuestionnaireState): number {
  const question = currentQuestion(state);
  return question ? question.options.length + 1 : 0;
}

export function questionnaireActionLabel(
  snapshot: QuestionnaireSnapshot,
  index: number,
): string | undefined {
  const question = snapshot.currentQuestion;
  if (!question) {
    return undefined;
  }
  if (index < question.options.length) {
    return question.options[index]?.label;
  }
  if (question.multiSelect === true) {
    return index === question.options.length ? NEXT_QUESTION_LABEL : undefined;
  }
  return index === question.options.length ? TYPE_SOMETHING_LABEL : undefined;
}

export function updateQuestionnaireState(
  state: QuestionnaireState,
  action: QuestionnaireAction,
): QuestionnaireUpdateResult {
  if (state.mode === "summary") {
    return updateSummary(state, action);
  }
  if (state.mode === "custom") {
    return updateInputMode(state, action);
  }
  return updateSelectMode(state, action);
}

function currentQuestion(state: QuestionnaireState) {
  return state.params.questions[state.questionIndex];
}

function advanceOrComplete(state: QuestionnaireState): void {
  state.selectedMultiIndexes.clear();
  if (state.questionIndex >= state.params.questions.length - 1) {
    state.mode = "summary";
    state.selectedIndex = 0;
    return;
  }

  state.questionIndex += 1;
  state.selectedIndex = 0;
  state.mode = "select";
}

function saveOption(state: QuestionnaireState, optionIndex: number): boolean {
  const question = currentQuestion(state);
  const option = question?.options[optionIndex];
  if (question === undefined || option === undefined) {
    return false;
  }

  state.notice = undefined;
  state.answers.push({
    questionIndex: state.questionIndex,
    question: question.question,
    kind: "option",
    answer: option.label,
    ...(option.preview ? { preview: option.preview } : {}),
  });
  advanceOrComplete(state);
  return true;
}

function saveMulti(state: QuestionnaireState): boolean {
  const question = currentQuestion(state);
  if (question === undefined) {
    return false;
  }

  const selected = Array.from(state.selectedMultiIndexes)
    .sort((left, right) => left - right)
    .map((index) => question.options[index]?.label)
    .filter((label): label is string => typeof label === "string");

  if (selected.length === 0) {
    state.notice = "Select at least one option before continuing.";
    return true;
  }

  state.notice = undefined;
  state.answers.push({
    questionIndex: state.questionIndex,
    question: question.question,
    kind: "multi",
    answer: null,
    selected,
  });
  advanceOrComplete(state);
  return true;
}

function enterInputMode(state: QuestionnaireState): void {
  state.mode = "custom";
  state.inputDraft = "";
  state.notice = undefined;
}

function submitInput(state: QuestionnaireState): QuestionnaireUpdateResult {
  const question = currentQuestion(state);
  if (question === undefined) {
    return { changed: false };
  }

  const trimmed = state.inputDraft.trim();
  state.notice = undefined;
  state.answers.push({
    questionIndex: state.questionIndex,
    question: question.question,
    kind: "custom",
    answer: trimmed || null,
  });
  advanceOrComplete(state);
  return { changed: true };
}

function toggleSelectedMultiOption(state: QuestionnaireState): boolean {
  const question = currentQuestion(state);
  if (question?.multiSelect !== true || state.selectedIndex >= question.options.length) {
    return false;
  }

  state.notice = undefined;
  if (state.selectedMultiIndexes.has(state.selectedIndex)) {
    state.selectedMultiIndexes.delete(state.selectedIndex);
  } else {
    state.selectedMultiIndexes.add(state.selectedIndex);
  }
  return true;
}

function handleSelectConfirm(state: QuestionnaireState): boolean {
  const question = currentQuestion(state);
  if (question === undefined) {
    return false;
  }

  if (question.multiSelect === true) {
    if (state.selectedIndex < question.options.length) {
      return toggleSelectedMultiOption(state);
    }
    if (state.selectedIndex === question.options.length) {
      return saveMulti(state);
    }
    return false;
  }

  if (state.selectedIndex < question.options.length) {
    return saveOption(state, state.selectedIndex);
  }
  if (state.selectedIndex === question.options.length) {
    enterInputMode(state);
    return true;
  }
  return false;
}

function updateSummary(
  state: QuestionnaireState,
  action: QuestionnaireAction,
): QuestionnaireUpdateResult {
  if (action.type === "confirm") {
    return { changed: false, terminal: { status: "completed", answers: [...state.answers] } };
  }
  if (action.type === "cancel") {
    return { changed: false, terminal: { status: "cancelled", answers: [...state.answers] } };
  }
  return { changed: false };
}

function updateInputMode(
  state: QuestionnaireState,
  action: QuestionnaireAction,
): QuestionnaireUpdateResult {
  switch (action.type) {
    case "confirm":
      return submitInput(state);
    case "cancel":
      state.mode = "select";
      state.inputDraft = "";
      return { changed: true };
    case "backspace":
      if (state.inputDraft.length === 0) {
        return { changed: false };
      }
      state.inputDraft = [...state.inputDraft].slice(0, -1).join("");
      return { changed: true };
    case "appendInput":
      state.inputDraft += action.text;
      return { changed: true };
    default:
      return { changed: false };
  }
}

function updateSelectMode(
  state: QuestionnaireState,
  action: QuestionnaireAction,
): QuestionnaireUpdateResult {
  switch (action.type) {
    case "cancel":
      return { changed: false, terminal: { status: "cancelled", answers: [...state.answers] } };
    case "move": {
      const next = Math.min(
        questionnaireItemCount(state) - 1,
        Math.max(0, state.selectedIndex + action.delta),
      );
      if (next === state.selectedIndex) {
        return { changed: false };
      }
      state.selectedIndex = next;
      return { changed: true };
    }
    case "toggle":
      return { changed: toggleSelectedMultiOption(state) };
    case "confirm":
      return { changed: handleSelectConfirm(state) };
    default:
      return { changed: false };
  }
}
