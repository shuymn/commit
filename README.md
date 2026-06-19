# commit

Standalone Bun CLI that runs pi's `commit` skill to create local git commits in meaningful units.

## Setup

```bash
bun install
```

`postinstall` runs `lefthook install` automatically.

## Run locally

From any git repository you want to commit:

```bash
bun run /path/to/commit/src/index.ts --help
bun run /path/to/commit/src/index.ts --english
bun run /path/to/commit/src/index.ts --japanese
bun run /path/to/commit/src/index.ts --branch --base main
```

When developing this repository, the equivalent command is:

```bash
bun run start -- --help
```

The CLI resolves the current git repository root and runs one pi SDK agent session with the bundled `skills/commit` asset.

## Flags

```text
--english          Prefer English commit messages
--japanese         Prefer Japanese commit messages
--branch           Create a new branch before committing
--base <branch>    Base branch to use with --branch
-h, --help         Show help
```

`--base` requires `--branch`.

## Credentials

This CLI uses `@earendil-works/pi-coding-agent`, so model credentials come from pi's normal auth resolution: pi auth storage, configured models, or provider environment variables such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and similar.

Model selection flags are not implemented yet; configure the default model through pi settings.

## Safety boundaries

- Exposes only `read`, `bash`, `grep`, `find`, `ls`, and `ask_user_question` to the agent; `edit` and `write` are not enabled.
- The bundled skill instructs the agent to create local commits only: no push, pull requests, merge, or rebase.
- The bundled skill instructs the agent to surface hook failures without bypassing hooks.
- The bundled skill instructs the agent to stop on signing failures without altering git signing configuration.
- If the agent needs to ask a question in a non-TTY environment, the question tool returns a clear cancellation instead of guessing.

Because `bash` is available for git operations, the git-operation restrictions above are skill-instruction boundaries rather than a shell command denylist.

## Skill asset

The bundled default skill is `skills/commit/SKILL.md`. To test another checkout of the skill, set:

```bash
COMMIT_SKILL_PATH=/path/to/skills/commit/SKILL.md bun run /path/to/commit/src/index.ts
```

`COMMIT_SKILL_PATH` may point to either the skill directory or the `SKILL.md` file.

## Optional manual smoke test

Use a disposable repository because the command may create real local commits:

```bash
tmp=$(mktemp -d)
cd "$tmp"
git init -b main
printf 'hello\n' > hello.txt
bun run /path/to/commit/src/index.ts --english
```

## Local development

```bash
bun run lint
bun run lint:fix
bun run fmt:check
bun run fmt:fix
bun run typecheck
bun run test
bun run check:fast
bun run check
```
