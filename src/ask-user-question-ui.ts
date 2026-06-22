import {
  decodeKittyPrintable,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
  type AskUiResult,
  createQuestionnaireState,
  type QuestionnaireAction,
  type QuestionnaireSnapshot,
  questionnaireActionLabel,
  questionnaireSnapshot,
  updateQuestionnaireState,
} from "./ask-user-question-state";
import type { AskUserQuestionInput } from "./ask-user-question-types";
import { NEXT_QUESTION_LABEL, TYPE_SOMETHING_LABEL } from "./ask-user-question-types";

export type { AskUiResult } from "./ask-user-question-state";

type ThemeLike = {
  readonly fg: (name: string, text: string) => string;
  readonly bold: (text: string) => string;
};

type KeybindingsLike = {
  readonly matches?: (data: string, id: string) => boolean;
};

type TuiLike = {
  readonly requestRender: () => void;
};

type Done = (result: AskUiResult) => void;

const ESCAPE = String.fromCharCode(0x1b);
const BRACKETED_PASTE_START = `${ESCAPE}[200~`;
const BRACKETED_PASTE_END = `${ESCAPE}[201~`;

export function printableInput(data: string): string | null {
  const decoded = decodeProtocolPrintable(data);
  if (decoded !== null) {
    return decoded;
  }

  const isBracketedPaste =
    data.startsWith(BRACKETED_PASTE_START) && data.endsWith(BRACKETED_PASTE_END);
  const raw = isBracketedPaste
    ? decodePastedControlSequences(
        data.slice(BRACKETED_PASTE_START.length, -BRACKETED_PASTE_END.length),
      )
    : data;
  if (!isBracketedPaste && raw.includes(ESCAPE)) {
    return null;
  }

  const text = [...raw]
    .filter((char) => {
      const code = char.charCodeAt(0);
      return !(code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f));
    })
    .join("");
  return text || null;
}

function decodeProtocolPrintable(data: string): string | null {
  return decodeKittyPrintable(data) ?? decodeModifyOtherKeysPrintable(data) ?? null;
}

function decodeModifyOtherKeysPrintable(data: string): string | null {
  const prefix = `${ESCAPE}[27;`;
  if (!data.startsWith(prefix) || !data.endsWith("~")) {
    return null;
  }

  const [modifierText, codepointText] = data.slice(prefix.length, -1).split(";");
  const modifier = Number.parseInt(modifierText ?? "", 10) - 1;
  const codepoint = Number.parseInt(codepointText ?? "", 10);
  const shiftModifier = 1;
  if (!Number.isFinite(modifier) || (modifier & ~shiftModifier) !== 0 || codepoint < 32) {
    return null;
  }

  try {
    return String.fromCodePoint(codepoint);
  } catch {
    return null;
  }
}

function decodePastedControlSequences(text: string): string {
  const ctrlSequencePattern = new RegExp(`${ESCAPE}\\[(\\d+);5u`, "g");
  return text.replace(ctrlSequencePattern, (match, code) => {
    const codepoint = Number.parseInt(code, 10);
    if (codepoint >= 97 && codepoint <= 122) {
      return String.fromCharCode(codepoint - 96);
    }
    if (codepoint >= 65 && codepoint <= 90) {
      return String.fromCharCode(codepoint - 64);
    }
    return match;
  });
}

export function createQuestionnaireComponent(
  params: AskUserQuestionInput,
  tui: TuiLike,
  theme: ThemeLike,
  keybindings: KeybindingsLike,
  done: Done,
) {
  const state = createQuestionnaireState(params);
  const matchesSelect = (
    data: string,
    id: string,
    fallback: Parameters<typeof matchesKey>[1],
  ): boolean => (keybindings.matches?.(data, id) ?? false) || matchesKey(data, fallback);

  function refresh() {
    tui.requestRender();
  }

  function apply(action: QuestionnaireAction) {
    const result = updateQuestionnaireState(state, action);
    if (result.terminal !== undefined) {
      done(result.terminal);
      return;
    }
    if (result.changed) {
      refresh();
    }
  }

  function handleInput(data: string) {
    const snapshot = questionnaireSnapshot(state);

    if (snapshot.mode === "summary") {
      if (matchesSelect(data, "tui.select.confirm", Key.enter)) {
        apply({ type: "confirm" });
      } else if (matchesSelect(data, "tui.select.cancel", Key.escape)) {
        apply({ type: "cancel" });
      }
      return;
    }

    if (snapshot.mode === "custom") {
      if (matchesKey(data, Key.enter)) {
        apply({ type: "confirm" });
        return;
      }
      if (matchesKey(data, Key.escape)) {
        apply({ type: "cancel" });
        return;
      }
      if (matchesKey(data, Key.backspace) || matchesKey(data, Key.ctrl("h"))) {
        apply({ type: "backspace" });
        return;
      }
      const printable = printableInput(data);
      if (printable !== null) {
        apply({ type: "appendInput", text: printable });
      }
      return;
    }

    if (matchesSelect(data, "tui.select.cancel", Key.escape)) {
      apply({ type: "cancel" });
      return;
    }
    if (matchesSelect(data, "tui.select.up", Key.up)) {
      apply({ type: "move", delta: -1 });
      return;
    }
    if (matchesSelect(data, "tui.select.down", Key.down)) {
      apply({ type: "move", delta: 1 });
      return;
    }
    if (
      matchesKey(data, Key.space) &&
      snapshot.currentQuestion?.multiSelect === true &&
      snapshot.selectedIndex < snapshot.currentQuestion.options.length
    ) {
      apply({ type: "toggle" });
      return;
    }
    if (matchesSelect(data, "tui.select.confirm", Key.enter)) {
      apply({ type: "confirm" });
    }
  }

  function renderOptionLine(
    snapshot: QuestionnaireSnapshot,
    width: number,
    index: number,
    label: string,
    description?: string,
    checked?: boolean,
  ): string[] {
    const selected = index === snapshot.selectedIndex;
    const pointerText = selected ? "> " : "  ";
    const checkboxText = checked === undefined ? "" : checked ? "[✓] " : "[ ] ";
    const indexPrefix = `${index + 1}. `;
    const prefixWidth = visibleWidth(pointerText + checkboxText + indexPrefix);
    const pointer = selected ? theme.fg("accent", pointerText) : pointerText;
    const checkbox =
      checked === undefined
        ? ""
        : checked
          ? theme.fg("success", checkboxText)
          : theme.fg("dim", checkboxText);
    const title = selected ? theme.fg("accent", theme.bold(label)) : theme.fg("text", label);
    const titlePrefix = `${pointer}${checkbox}${indexPrefix}`;

    if (width <= prefixWidth) {
      return [truncateToWidth(`${titlePrefix}${title}`, width)];
    }

    const contentWidth = width - prefixWidth;
    const padding = " ".repeat(prefixWidth);
    const titleLines = wrapTextWithAnsi(title, contentWidth);
    const lines = titleLines.map((line, lineIndex) =>
      truncateToWidth(`${lineIndex === 0 ? titlePrefix : padding}${line}`, width),
    );
    if (description !== undefined && description.length > 0) {
      for (const line of wrapTextWithAnsi(theme.fg("muted", description), contentWidth)) {
        lines.push(truncateToWidth(`${padding}${line}`, width));
      }
    }
    return lines;
  }

  function render(width: number): string[] {
    const snapshot = questionnaireSnapshot(state);
    const question = snapshot.currentQuestion;
    const lines: string[] = [];
    const add = (line = "") => lines.push(truncateToWidth(line, width));
    const addWrapped = (line = "", prefix = "") => {
      if (line.length === 0) {
        add("");
        return;
      }
      const wrapped = wrapTextWithAnsi(line, Math.max(1, width - visibleWidth(prefix)));
      for (const wrappedLine of wrapped) {
        add(`${prefix}${wrappedLine}`);
      }
    };

    add(theme.fg("accent", "─".repeat(Math.max(0, width))));
    add(
      `${theme.fg("toolTitle", theme.bold("ask_user_question"))} ${theme.fg("muted", `${snapshot.questionIndex + 1}/${snapshot.questionCount}`)}`,
    );
    add("");

    if (snapshot.mode === "summary") {
      add(theme.fg("success", theme.bold("Ready to submit")));
      add("");
      for (const answer of snapshot.answers) {
        const value =
          answer.kind === "multi" ? answer.selected.join(", ") : (answer.answer ?? "(no response)");
        addWrapped(value, `Q${answer.questionIndex + 1}: `);
      }
      add("");
      add(theme.fg("dim", "Enter submit • Esc cancel"));
      add(theme.fg("accent", "─".repeat(Math.max(0, width))));
      return lines;
    }

    if (question === undefined) {
      add(theme.fg("warning", "No question"));
      return lines;
    }

    add(theme.fg("accent", theme.bold(question.header)));
    addWrapped(theme.fg("text", theme.bold(question.question)));
    add("");

    if (snapshot.mode === "custom") {
      add(theme.fg("accent", "Type your answer:"));
      addWrapped(snapshot.inputDraft || theme.fg("dim", "(empty)"));
      add("");
      add(theme.fg("dim", "Enter submit • Esc back"));
      add(theme.fg("accent", "─".repeat(Math.max(0, width))));
      return lines;
    }

    if (snapshot.notice !== undefined) {
      add(theme.fg("warning", snapshot.notice));
      add("");
    }

    if (question.multiSelect === true) {
      for (const [index, option] of question.options.entries()) {
        lines.push(
          ...renderOptionLine(
            snapshot,
            width,
            index,
            option.label,
            option.description,
            snapshot.selectedMultiIndexes.has(index),
          ),
        );
      }
      lines.push(
        ...renderOptionLine(
          snapshot,
          width,
          question.options.length,
          questionnaireActionLabel(snapshot, question.options.length) ?? NEXT_QUESTION_LABEL,
          "Submit selected options.",
        ),
      );
      add("");
      add(theme.fg("dim", "↑↓ navigate • Space toggle • Enter confirm • Esc cancel"));
    } else {
      question.options.forEach((option, index) => {
        lines.push(...renderOptionLine(snapshot, width, index, option.label, option.description));
        if (
          option.preview !== undefined &&
          option.preview.length > 0 &&
          index === snapshot.selectedIndex
        ) {
          add(`     ${theme.fg("dim", "Preview:")}`);
          for (const previewLine of option.preview.split("\n").slice(0, 8)) {
            addWrapped(theme.fg("muted", previewLine), "     ");
          }
        }
      });
      lines.push(
        ...renderOptionLine(
          snapshot,
          width,
          question.options.length,
          questionnaireActionLabel(snapshot, question.options.length) ?? TYPE_SOMETHING_LABEL,
          "Enter a custom answer.",
        ),
      );
      add("");
      add(theme.fg("dim", "↑↓ navigate • Enter select • Esc cancel"));
    }

    add(theme.fg("accent", "─".repeat(Math.max(0, width))));
    return lines;
  }

  function cancel(): AskUiResult {
    const snapshot = questionnaireSnapshot(state);
    const result: AskUiResult = { status: "cancelled", answers: snapshot.answers };
    done(result);
    return result;
  }

  return { render, handleInput, invalidate: refresh, cancel };
}
