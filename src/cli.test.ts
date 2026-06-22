import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { type CommandRunner, runCommandWithBun } from "./command";
import { formatUsage, parseCliArgs, UNSAFE_BASE_BRANCH_MESSAGE } from "./cli";
import { resolveGitRepositoryCwd } from "./git";
import { main } from "./index";

const makeRunner = (result: {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}): CommandRunner => {
  return async () => ({
    exitCode: result.exitCode,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  });
};

const runGit = async (args: readonly string[], cwd: string) => {
  const result = await runCommandWithBun(["git", ...args], cwd);
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }

  return result.stdout;
};

describe("parseCliArgs", () => {
  test("prints help instead of running", () => {
    expect(parseCliArgs(["--help"])).toEqual({ kind: "help" });
  });

  test("parses selected flags", () => {
    expect(parseCliArgs(["--japanese", "--branch", "--base", "main"])).toEqual({
      kind: "run",
      options: { language: "japanese", branch: true, base: "main" },
    });
  });

  test("rejects conflicting languages", () => {
    expect(parseCliArgs(["--english", "--japanese"])).toEqual({
      kind: "error",
      message: "Choose either --english or --japanese, not both.",
    });
  });

  test("rejects base without branch", () => {
    expect(parseCliArgs(["--base=main"])).toEqual({
      kind: "error",
      message: "--base can only be used with --branch.",
    });
  });

  test("rejects unsafe base branch names", () => {
    expect(parseCliArgs(["--branch", "--base=--japanese"])).toEqual({
      kind: "error",
      message: UNSAFE_BASE_BRANCH_MESSAGE,
    });
    expect(parseCliArgs(["--branch", "--base", "main --japanese"])).toEqual({
      kind: "error",
      message: UNSAFE_BASE_BRANCH_MESSAGE,
    });
    expect(parseCliArgs(["--branch", "--base=release/v1.2.3"])).toEqual({
      kind: "run",
      options: { language: undefined, branch: true, base: "release/v1.2.3" },
    });
  });
});

describe("resolveGitRepositoryCwd", () => {
  test("returns the repository root reported by git", async () => {
    await expect(
      resolveGitRepositoryCwd("/work/tree", makeRunner({ exitCode: 0, stdout: "/repo\n" })),
    ).resolves.toEqual({
      cwd: "/repo",
    });
  });

  test("surfaces non-repository errors", async () => {
    await expect(
      resolveGitRepositoryCwd(
        "/not-a-repo",
        makeRunner({ exitCode: 128, stderr: "fatal: not a git repository\n" }),
      ),
    ).rejects.toThrow("Current directory is not inside a git repository: /not-a-repo");
  });
});

describe("main", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "commit-cli-"));
    await runGit(["init", "-b", "main"], tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("prints usage for --help without inspecting git", async () => {
    let stdout = "";
    let stderr = "";

    const exitCode = await main(["--help"], join(tempDir, "missing"), {
      stdout: {
        write: (chunk: string) => {
          stdout += chunk;
          return true;
        },
      },
      stderr: {
        write: (chunk: string) => {
          stderr += chunk;
          return true;
        },
      },
    });

    expect(exitCode).toBe(0);
    expect(stdout).toBe(formatUsage());
    expect(stderr).toBe("");
  });

  test("returns an error when the workflow fails", async () => {
    let stderr = "";

    const exitCode = await main(
      [],
      tempDir,
      {
        stdout: { write: () => true },
        stderr: {
          write: (chunk: string) => {
            stderr += chunk;
            return true;
          },
        },
      },
      {
        runWorkflow: async () => {
          throw new Error("workflow failed");
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(stderr).toBe("workflow failed\n");
  });

  test("passes parsed options and repository root to the workflow without modifying git state", async () => {
    let stdout = "";
    let stderr = "";
    const workflowCalls: Array<{ cwd: string; options: unknown; uiMode: unknown }> = [];
    const beforeStatus = await runGit(["status", "--short"], tempDir);

    const exitCode = await main(
      ["--english", "--branch", "--base=main"],
      tempDir,
      {
        stdout: {
          write: (chunk: string) => {
            stdout += chunk;
            return true;
          },
        },
        stderr: {
          write: (chunk: string) => {
            stderr += chunk;
            return true;
          },
        },
      },
      {
        runWorkflow: async ({ cwd, options, uiMode }) => {
          workflowCalls.push({ cwd, options, uiMode });
        },
      },
    );

    const afterStatus = await runGit(["status", "--short"], tempDir);

    expect(exitCode).toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toBe("");
    expect(workflowCalls).toEqual([
      {
        options: { language: "english", branch: true, base: "main" },
        uiMode: "plain",
        cwd: await realpath(tempDir),
      },
    ]);
    expect(afterStatus).toBe(beforeStatus);
  });

  test("uses TUI mode for interactive runs", async () => {
    const workflowCalls: Array<{ uiMode: unknown }> = [];

    const exitCode = await main([], tempDir, undefined, {
      isInteractive: () => true,
      runWorkflow: async ({ uiMode }) => {
        workflowCalls.push({ uiMode });
      },
    });

    expect(exitCode).toBe(0);
    expect(workflowCalls).toEqual([{ uiMode: "tui" }]);
  });

  test("maps workflow cancellation to exit code 130", async () => {
    const exitCode = await main([], tempDir, undefined, {
      runWorkflow: async () => {
        throw { exitCode: 130 };
      },
    });

    expect(exitCode).toBe(130);
  });
});
