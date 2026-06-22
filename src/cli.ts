import type { CommitLanguage, CommitOptions } from "./commit-options";

export type CliParseResult =
  | { readonly kind: "run"; readonly options: CommitOptions }
  | { readonly kind: "help" }
  | { readonly kind: "error"; readonly message: string };

const USAGE = `Usage: commit [options]

Create local git commits in meaningful units using the commit skill.

Options:
  --english          Prefer English commit messages
  --japanese         Prefer Japanese commit messages
  --branch           Create a new branch before committing
  --base <branch>    Base branch to use with --branch
  -h, --help         Show this help
`;

export const formatUsage = (): string => USAGE;

export const UNSAFE_BASE_BRANCH_MESSAGE =
  "--base must be a safe branch name using only letters, numbers, '.', '_', '-', and '/'.";

const SAFE_BASE_BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export function validateBaseBranchName(value: string): string | undefined {
  if (
    !SAFE_BASE_BRANCH_PATTERN.test(value) ||
    value.includes("..") ||
    value.includes("//") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.endsWith(".lock")
  ) {
    return UNSAFE_BASE_BRANCH_MESSAGE;
  }

  return undefined;
}

export function parseCliArgs(argv: readonly string[]): CliParseResult {
  let language: CommitLanguage | undefined;
  let branch = false;
  let base: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === undefined) {
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      return { kind: "help" };
    }

    if (arg === "--english" || arg === "--japanese") {
      const nextLanguage = arg === "--english" ? "english" : "japanese";
      if (language !== undefined && language !== nextLanguage) {
        return { kind: "error", message: "Choose either --english or --japanese, not both." };
      }
      language = nextLanguage;
      continue;
    }

    if (arg === "--branch") {
      branch = true;
      continue;
    }

    if (arg === "--base" || arg.startsWith("--base=")) {
      let value: string | undefined;
      if (arg === "--base") {
        const next = argv[index + 1];
        if (next !== undefined && !next.startsWith("-")) {
          value = next;
          index += 1;
        }
      } else {
        value = arg.slice("--base=".length);
      }

      if (value === undefined || value.length === 0) {
        return { kind: "error", message: "--base requires a branch name." };
      }
      const baseError = validateBaseBranchName(value);
      if (baseError !== undefined) {
        return { kind: "error", message: baseError };
      }
      base = value;
      continue;
    }

    if (arg.startsWith("-")) {
      return { kind: "error", message: `Unknown option: ${arg}` };
    }

    return { kind: "error", message: `Unexpected positional argument: ${arg}` };
  }

  if (base !== undefined && !branch) {
    return { kind: "error", message: "--base can only be used with --branch." };
  }

  return { kind: "run", options: { language, branch, base } };
}
