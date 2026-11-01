# Agent Instructions

## Start here

Play Nice is a private, unreleased OpenCode 2.2.2 V2 plugin. It scores the
current user message with a Decision API, can reject it before admission, and
offers on-demand reflection on selected evaluations. It does not install or
start the Decision service. OpenCode V1 plugin APIs are not compatible.

Read [README.md](README.md) for setup, behavior, configuration and privacy;
[CONTRIBUTING.md](CONTRIBUTING.md) for development checks; and
[tests/native/README.md](tests/native/README.md) before native integration work.
`package.json` and `bun.lock` pin the runtime dependencies and toolchain.

## Code map and behavior

- `src/server.ts`: native prompt hook, classification policy, feedback,
  reflection command and lifecycle.
- `src/decision.ts`: current-message Score request and response validation;
  `src/tone.ts`: score criteria and labels; `src/config.ts`: option validation.
- `src/prompt-boundary.ts`: pre-admission allow/reject and feedback sequencing.
- `src/tui.ts` and `src/rpc.ts`: TUI feedback, receipt handling and RPC contract.
- `src/history.ts`: local, bounded per-message reflection records.

Scoring and rejection are separate: rejection is opt-in and uses the unrounded
score. A session identified as a child skips the hook's scoring and rejection;
if session lookup fails or times out, normal policy still applies. Classification
sends only the current message text, not conversation history, to Decision.
Reflection stores selected evaluations locally and sends them with available
context to the current session's agent and provider, which may be remote. An
allowed policy outcome is not proof of durable admission.

## Build and verification

The root package exports TypeScript source. The build replaces `dist/` and creates
a separate compiled package with `server`, `tui` and `rpc` exports. Do not assume
building changes the root exports or that `dist` is a standalone distribution.
The native assembled fixture copies source modules using explicit lists; update
those lists when adding a production module needed by the fixture.

Choose checks for the change using [CONTRIBUTING.md](CONTRIBUTING.md). The native
suite is explicit opt-in and has strict prerequisites; do not change host config
to pass preflight. Its assembled source-package fixture and headless TUI do not
prove compiled-package native execution or visible toast rendering. Package
host-load checks do not establish native behavior. Report what was actually run.

## Workflow boundaries

Use `bd` for tracking and run `bd prime` for current workflow context. The local
Dolt database is the issue source of truth; `.beads/issues.jsonl` is a passive
export, not the sync protocol. Managed Beads guidance below is subordinate to
active higher-priority instructions. In particular, honor any applicable Beads
sequence checkpoint authority and any explicit prohibition on commits or sync;
do not infer permission to push or sync remotely.

Keep shell operations non-interactive. Check targets before destructive or broad
operations, and do not use force or recursive deletion merely to avoid a prompt.
Follow the active environment's directory and privilege restrictions.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:970c3bf2 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   bd dolt push
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->

<!-- BEGIN BEADS CODEX SETUP: generated by bd setup codex -->
## Beads Issue Tracker

Use Beads (`bd`) for durable task tracking in repositories that include it. Use the `beads` skill at `.agents/skills/beads/SKILL.md` (project install) or `~/.agents/skills/beads/SKILL.md` (global install) for Beads workflow guidance, then use the `bd` CLI for issue operations.

### Quick Reference

```bash
bd ready                # Find available work
bd show <id>            # View issue details
bd update <id> --claim  # Claim work
bd close <id>           # Complete work
bd prime                # Refresh Beads context
```

### Rules

- Use `bd` for all task tracking; do not create markdown TODO lists.
- Run `bd prime` when Beads context is missing or stale. Codex 0.129.0+ can load Beads context automatically through native hooks; use `/hooks` to inspect or toggle them.
- Keep persistent project memory in Beads via `bd remember`; do not create ad hoc memory files.

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.
<!-- END BEADS CODEX SETUP -->
