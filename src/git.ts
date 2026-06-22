import { type CommandRunner, runCommandWithBun } from "./command";

export type ResolvedRepository = {
  readonly cwd: string;
};

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
