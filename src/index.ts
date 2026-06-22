#!/usr/bin/env bun
import type { CommitWorkflowIo, RunCommitWorkflowOptions } from "./commit-workflow";
import { formatUsage, parseCliArgs } from "./cli";
import { resolveGitRepositoryCwd } from "./git";

export type WorkflowRunner = (
  input: Pick<RunCommitWorkflowOptions, "cwd" | "options" | "io" | "uiMode">,
) => Promise<void>;

export type MainDependencies = {
  readonly runWorkflow?: WorkflowRunner;
  readonly isInteractive?: () => boolean;
};

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  cwd: string = process.cwd(),
  io: CommitWorkflowIo = { stdout: process.stdout, stderr: process.stderr },
  dependencies: MainDependencies = {},
): Promise<number> {
  const parsed = parseCliArgs(argv);

  if (parsed.kind === "help") {
    io.stdout.write(formatUsage());
    return 0;
  }

  if (parsed.kind === "error") {
    io.stderr.write(`${parsed.message}\n\n${formatUsage()}`);
    return 1;
  }

  try {
    const repository = await resolveGitRepositoryCwd(cwd);
    const runWorkflow =
      dependencies.runWorkflow ?? (await import("./commit-workflow")).runCommitWorkflow;
    await runWorkflow({
      cwd: repository.cwd,
      options: parsed.options,
      io,
      uiMode: (dependencies.isInteractive?.() ?? isProcessInteractive()) ? "tui" : "plain",
    });
    return 0;
  } catch (error) {
    if (isExitCodeError(error, 130)) {
      return 130;
    }
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await main();
}

function isProcessInteractive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

function isExitCodeError(error: unknown, exitCode: number): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "exitCode" in error &&
    (error as { readonly exitCode?: unknown }).exitCode === exitCode
  );
}
