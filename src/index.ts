#!/usr/bin/env bun
import type { CliOptions } from "./cli";
import { formatUsage, parseCliArgs, resolveGitRepositoryCwd } from "./cli";

export type CliIo = {
  readonly stdout: Pick<typeof process.stdout, "write">;
  readonly stderr: Pick<typeof process.stderr, "write">;
};

export type WorkflowRunner = (input: {
  readonly cwd: string;
  readonly options: CliOptions;
  readonly io: CliIo;
}) => Promise<void>;

export type MainDependencies = {
  readonly runWorkflow?: WorkflowRunner;
};

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  cwd: string = process.cwd(),
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
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
    });
    return 0;
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await main();
}
