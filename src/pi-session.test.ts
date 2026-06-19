import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { AuthStorage, ModelRegistry, SettingsManager } from "@earendil-works/pi-coding-agent";
import { ASK_USER_QUESTION_TOOL_NAME, createAskUserQuestionTool } from "./ask-user-question";
import {
  COMMIT_AGENT_TOOL_NAMES,
  COMMIT_SKILL_PATH_ENV,
  createCommitAgentResourceLoader,
  createCommitAgentSession,
  resolveCommitSkillPath,
} from "./pi-session";

async function createCommitSkillFixture(
  root: string,
): Promise<{ skillDir: string; skillFile: string }> {
  const skillDir = join(root, "commit");
  const skillFile = join(skillDir, "SKILL.md");
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    skillFile,
    [
      "---",
      "name: commit",
      "description: Creates meaningful git commits for tests.",
      "---",
      "",
      "# Commit test skill",
      "",
    ].join("\n"),
  );

  return { skillDir, skillFile };
}

describe("commit skill loading", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "commit-skill-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("resolves the bundled commit skill by default", async () => {
    await expect(resolveCommitSkillPath()).resolves.toBe(resolve("skills/commit/SKILL.md"));
  });

  test("resolves an explicit skill directory", async () => {
    const { skillDir, skillFile } = await createCommitSkillFixture(tempDir);

    await expect(resolveCommitSkillPath({ skillPath: skillDir })).resolves.toBe(resolve(skillFile));
  });

  test("resolves the environment override", async () => {
    const { skillFile } = await createCommitSkillFixture(tempDir);

    await expect(
      resolveCommitSkillPath({ env: { [COMMIT_SKILL_PATH_ENV]: skillFile } }),
    ).resolves.toBe(resolve(skillFile));
  });

  test("fails clearly when the skill path is missing", async () => {
    await expect(resolveCommitSkillPath({ skillPath: join(tempDir, "missing") })).rejects.toThrow(
      "Commit skill not found",
    );
  });

  test("loads the commit skill into a resource loader", async () => {
    const { skillDir, skillFile } = await createCommitSkillFixture(tempDir);
    const { resourceLoader, skillPath } = await createCommitAgentResourceLoader({
      cwd: tempDir,
      skillPath: skillDir,
      settingsManager: SettingsManager.inMemory(),
    });

    const skills = resourceLoader.getSkills().skills;

    expect(skillPath).toBe(resolve(skillFile));
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({ name: "commit", filePath: resolve(skillFile) });
  });

  test("creates a session with the commit skill and constrained tools without a live model call", async () => {
    const { skillDir } = await createCommitSkillFixture(tempDir);
    const authStorage = AuthStorage.inMemory();
    const modelRegistry = ModelRegistry.inMemory(authStorage);
    const { session } = await createCommitAgentSession({
      cwd: tempDir,
      skillPath: skillDir,
      authStorage,
      modelRegistry,
      settingsManager: SettingsManager.inMemory(),
    });

    try {
      expect(session.resourceLoader.getSkills().skills.map((skill) => skill.name)).toEqual([
        "commit",
      ]);
      expect(session.getActiveToolNames().sort()).toEqual([...COMMIT_AGENT_TOOL_NAMES].sort());
      expect(session.getActiveToolNames()).not.toContain("edit");
      expect(session.getActiveToolNames()).not.toContain("write");
    } finally {
      session.dispose();
    }
  });

  test("can add a custom question tool to the constrained session", async () => {
    const { skillDir } = await createCommitSkillFixture(tempDir);
    const authStorage = AuthStorage.inMemory();
    const modelRegistry = ModelRegistry.inMemory(authStorage);
    const customTool = createAskUserQuestionTool({
      isInteractive: () => false,
      write: () => {},
      readLine: async () => undefined,
    });
    const { session } = await createCommitAgentSession({
      cwd: tempDir,
      skillPath: skillDir,
      authStorage,
      modelRegistry,
      settingsManager: SettingsManager.inMemory(),
      customTools: [customTool],
      toolNames: [...COMMIT_AGENT_TOOL_NAMES, ASK_USER_QUESTION_TOOL_NAME],
    });

    try {
      expect(session.getActiveToolNames().sort()).toEqual(
        [...COMMIT_AGENT_TOOL_NAMES, ASK_USER_QUESTION_TOOL_NAME].sort(),
      );
      expect(session.getActiveToolNames()).not.toContain("edit");
      expect(session.getActiveToolNames()).not.toContain("write");
    } finally {
      session.dispose();
    }
  });
});
