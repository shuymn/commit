export type CommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type CommandRunner = (command: readonly string[], cwd: string) => Promise<CommandResult>;

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
