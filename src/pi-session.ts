import { access, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type AuthStorage,
  type CreateAgentSessionResult,
  type ModelRegistry,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { isObjectRecord } from "./tool-result";

export const COMMIT_SKILL_PATH_ENV = "COMMIT_SKILL_PATH";
export const COMMIT_AGENT_TOOL_NAMES = ["read", "bash", "grep", "find", "ls"] as const;

export type CommitSkillResolutionOptions = {
  readonly skillPath?: string;
  readonly env?: Record<string, string | undefined>;
};

export type CommitAgentResourceLoaderOptions = CommitSkillResolutionOptions & {
  readonly cwd: string;
  readonly agentDir?: string;
  readonly settingsManager?: SettingsManager;
};

export type CommitAgentSessionOptions = CommitAgentResourceLoaderOptions & {
  readonly authStorage?: AuthStorage;
  readonly modelRegistry?: ModelRegistry;
  readonly sessionManager?: SessionManager;
  readonly customTools?: readonly ToolDefinition[];
  readonly toolNames?: readonly string[];
};

export type CommitAgentResourceLoaderResult = {
  readonly resourceLoader: DefaultResourceLoader;
  readonly settingsManager: SettingsManager;
  readonly skillPath: string;
};

export type CommitAgentSessionResult = CreateAgentSessionResult & CommitAgentResourceLoaderResult;

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

const defaultCommitSkillCandidates = [
  // Bundled layout: skill ships inside this package (packageRoot/skills/commit).
  resolve(packageRoot, "skills/commit/SKILL.md"),
  // Installed-as-dependency layout: packageRoot is node_modules/<pkg>, so the
  // sibling "skills" package resolves to node_modules/skills/commit.
  resolve(packageRoot, "../skills/skills/commit/SKILL.md"),
];

export async function resolveCommitSkillPath(
  options: CommitSkillResolutionOptions = {},
): Promise<string> {
  const explicitPath = options.skillPath ?? options.env?.[COMMIT_SKILL_PATH_ENV];
  const candidates = explicitPath === undefined ? defaultCommitSkillCandidates : [explicitPath];

  // A real I/O fault on one candidate (e.g. EACCES) must not skip the remaining
  // candidates or the guidance below; remember the first fault and surface it as
  // the error cause once every candidate has been tried.
  let resolutionError: unknown;
  for (const candidate of candidates) {
    const resolved = resolve(candidate);
    try {
      const skillFile = await resolveSkillFile(resolved);
      if (skillFile !== undefined) {
        return skillFile;
      }
    } catch (error) {
      resolutionError ??= error;
    }
  }

  if (explicitPath !== undefined) {
    throw new Error(`Commit skill not found at ${resolve(explicitPath)}`, {
      cause: resolutionError,
    });
  }

  throw new Error(
    `Commit skill not found. Set ${COMMIT_SKILL_PATH_ENV} to the commit skill directory or SKILL.md file. Tried:\n${defaultCommitSkillCandidates
      .map((candidate) => `- ${candidate}`)
      .join("\n")}`,
    { cause: resolutionError },
  );
}

export async function createCommitAgentResourceLoader(
  options: CommitAgentResourceLoaderOptions,
): Promise<CommitAgentResourceLoaderResult> {
  const agentDir = options.agentDir ?? getAgentDir();
  const settingsManager = options.settingsManager ?? SettingsManager.create(options.cwd, agentDir);
  const skillPath = await resolveCommitSkillPath(options);
  const resourceLoader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir,
    settingsManager,
    additionalSkillPaths: [skillPath],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
  });

  await resourceLoader.reload();
  assertCommitSkillLoaded(resourceLoader, skillPath);

  return { resourceLoader, settingsManager, skillPath };
}

export async function createCommitAgentSession(
  options: CommitAgentSessionOptions,
): Promise<CommitAgentSessionResult> {
  const { resourceLoader, settingsManager, skillPath } =
    await createCommitAgentResourceLoader(options);
  const tools = [...(options.toolNames ?? COMMIT_AGENT_TOOL_NAMES)];
  const customTools = options.customTools === undefined ? undefined : [...options.customTools];
  const sessionResult = await createAgentSession({
    cwd: options.cwd,
    agentDir: options.agentDir,
    authStorage: options.authStorage,
    modelRegistry: options.modelRegistry,
    resourceLoader,
    settingsManager,
    sessionManager: options.sessionManager ?? SessionManager.inMemory(options.cwd),
    tools,
    customTools,
  });

  return { ...sessionResult, resourceLoader, settingsManager, skillPath };
}

function assertCommitSkillLoaded(resourceLoader: DefaultResourceLoader, skillPath: string): void {
  const { skills, diagnostics } = resourceLoader.getSkills();
  const commitSkill = skills.find((skill) => skill.name === "commit");

  if (commitSkill !== undefined) {
    return;
  }

  const diagnosticsText = diagnostics
    .map((diagnostic) => `${diagnostic.type}: ${diagnostic.message} (${diagnostic.path})`)
    .join("\n");
  const suffix = diagnosticsText.length > 0 ? `\n${diagnosticsText}` : "";
  throw new Error(`Commit skill did not load from ${skillPath}.${suffix}`);
}

async function resolveSkillFile(path: string): Promise<string | undefined> {
  try {
    const stats = await stat(path);
    if (stats.isDirectory()) {
      const skillFile = resolve(path, "SKILL.md");
      await access(skillFile);
      return skillFile;
    }
    if (stats.isFile() && path.endsWith(".md")) {
      return path;
    }
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
  }

  return undefined;
}

function isMissingFileError(error: unknown): boolean {
  return isObjectRecord(error) && (error.code === "ENOENT" || error.code === "ENOTDIR");
}
