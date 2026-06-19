export type CommitLanguage = "english" | "japanese";

export type CliOptions = {
  readonly language?: CommitLanguage;
  readonly branch: boolean;
  readonly base?: string;
};

export type CliParseResult =
  | { readonly kind: "run"; readonly options: CliOptions }
  | { readonly kind: "help" }
  | { readonly kind: "error"; readonly message: string };

export type CommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type CommandRunner = (command: readonly string[], cwd: string) => Promise<CommandResult>;

export type ResolvedRepository = {
  readonly cwd: string;
};

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

    if (arg === "--base") {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("-")) {
        return { kind: "error", message: "--base requires a branch name." };
      }
      const baseError = validateBaseBranchName(next);
      if (baseError !== undefined) {
        return { kind: "error", message: baseError };
      }
      base = next;
      index += 1;
      continue;
    }

    if (arg.startsWith("--base=")) {
      const value = arg.slice("--base=".length);
      if (value.length === 0) {
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

export async function resolveGitRepositoryCwd(
  cwd: string,
  runCommand: CommandRunner = runCommandWithBun,
): Promise<ResolvedRepository> {
  const result = await runCommand(["git", "rev-parse", "--show-toplevel"], cwd);

  if (result.exitCode !== 0) {
    const detail = result.stderr.trim();
    const suffix = detail.length > 0 ? `\n${detail}` : "";
    throw new Error(`Current directory is not inside a git repository: ${cwd}${suffix}`);
  }

  const repositoryCwd = result.stdout.trim();
  if (repositoryCwd.length === 0) {
    throw new Error(`Could not determine git repository root for: ${cwd}`);
  }

  return { cwd: repositoryCwd };
}

export async function runCommandWithBun(
  command: readonly string[],
  cwd: string,
): Promise<CommandResult> {
  const subprocess = Bun.spawn([...command], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ]);

  return { exitCode, stdout, stderr };
}
