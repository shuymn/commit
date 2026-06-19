import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCommandWithBun } from "./cli";
import { main } from "./index";

const runGit = async (args: readonly string[], cwd: string) => {
  const result = await runCommandWithBun(["git", ...args], cwd);
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }

  return result.stdout;
};

describe("disposable git fixture verification", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "commit-fixture-"));
    await runGit(["init", "-b", "main"], tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("CLI starts the workflow in a changed repository without staging or committing first", async () => {
    await writeFile(join(tempDir, "feature.txt"), "one logical change\n");
    const beforeStatus = await runGit(["status", "--short"], tempDir);
    const workflowStatuses: string[] = [];

    const exitCode = await main(
      ["--japanese"],
      tempDir,
      {
        stdout: { write: () => true },
        stderr: { write: () => true },
      },
      {
        runWorkflow: async ({ cwd, options }) => {
          workflowStatuses.push(await runGit(["status", "--short"], cwd));
          expect(options).toEqual({ language: "japanese", branch: false, base: undefined });
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(workflowStatuses).toEqual([beforeStatus]);
    expect(await runGit(["status", "--short"], tempDir)).toBe(beforeStatus);
    expect(await runGit(["log", "--oneline"], tempDir).catch((error) => error.message)).toContain(
      "does not have any commits yet",
    );
  });
});

describe("bundled commit skill safety invariants", () => {
  test("preserves local-only and failure-handling boundaries", async () => {
    const skill = await readFile("skills/commit/SKILL.md", "utf8");
    const examples = await readFile("skills/commit/references/examples.md", "utf8");

    expect(skill).toContain("Creates local commits only");
    expect(skill).toContain("no `git push`, no pull requests");
    expect(skill).toContain("Never bypass hooks");
    expect(skill).toContain("Do NOT change signing config");
    expect(skill).toContain("Use AskUserQuestionTool if available");
    expect(examples).toContain("Patch-Based Partial Staging");
  });
});
