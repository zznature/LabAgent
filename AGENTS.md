# Development Rules

Goal: Develop experimental research agents based on pi-agent. Intend to build first auto-research demo on Raman experiments.
MVP Status: develop the extension `src/extensions/experiment-research` to adapt pi-agent for in-lab applications.

Implementation should always follow `docs/design-ideas/core-ideas.md`, which is user-authored design guidelines.
- When implementation may go beyond the design, ask user to improve it.
- Agent can only edit it with user's direct order.
- The tech designs are also in `docs/design-ideas/`. Tech docs should be updated with the actual implementing and reflect the actual code.


## Thinking from First Principles

### Mindset

- Always reason from first principles — reject blind experience and path dependence
- Simple is better than complex. Complex is better than complicated. Reject complexity unless it's absolutely necessary.
- Transform user's intents into fundamental components/patterns and build from there.
- Target the Causes to Solve, Not the Symptoms.

### Response Structure

Every non-trivial response must contain two sections:

1. **✅ ★ Direct Execution ★** — Deliver results that serve the user's *real* goal, not just the literal words.
2. **🔎 ★ Deep Thinking ★** — Always challenge the user with in-depth analysis, such as:
   - Insights: Dig insights in the building process
   - Questions: Whether the stated task fits the real goal
   - Improvements: Suggest more elegant / efficient / straightforward options when one exists

## Code Quality

- When new function/feature is proposed, always ASK: Is it necessary? Can it be constructed from existing functions?
- Read files in full before wide-ranging changes, before editing files you have not fully inspected, and when asked to investigate or audit. Do not rely on search snippets for broad changes.
- Inline single-line helpers that have only one call site.
- Check node_modules for external API types; don't guess.
- **No inline imports** (`await import()`, `import("pkg").Type`, dynamic type imports). Top-level imports only.
- Never remove or downgrade code to fix type errors from outdated deps; upgrade the dep instead.
- Always ask before removing functionality or code that appears intentional.

## Commands

- After code changes (not docs): `npm run check` (full output, no tail). Fix all errors, warnings, and infos before committing. Does not run tests.
- Never run `npm run build` or `npm test` unless requested by the user.
- Never run the full vitest suite directly: it includes e2e tests that activate when endpoint/auth env vars are present. For all non-e2e tests, run `./test.sh` from the repo root. Otherwise run specific tests from the package root: `node ../../node_modules/vitest/dist/cli.js --run test/specific.test.ts`.
- If you create or modify a test file, run it and iterate on test or implementation until it passes.
- For `packages/coding-agent/test/suite/`, use `test/suite/harness.ts` + the faux provider. No real provider APIs, keys, or paid tokens.
- Put issue-specific regressions under `packages/coding-agent/test/suite/regressions/` named `<issue-number>-<short-slug>.test.ts`.
- For ad-hoc scripts, `write` them to a temp file (e.g. `/tmp`), run, edit if needed, remove when done. Don't embed multi-line scripts in `bash` commands.

## Dependency and Install Security

- Treat npm dep and lockfile changes as reviewed code. Direct external deps stay pinned to exact versions.
- Hydrate/update locally with `npm install --ignore-scripts`; clean/CI-style with `npm ci --ignore-scripts`. Don't run lifecycle scripts unless the user asks.
- If dep metadata changes, refresh `package-lock.json` with `npm install --package-lock-only --ignore-scripts`.
- Pre-commit blocks lockfile commits unless `PI_ALLOW_LOCKFILE_CHANGE=1`. Don't bypass unless the user wants the lockfile change committed.

## Git

Follow these rules for committing:

- Stage explicit paths (`git add <path1> <path2>`); never `git add -A` / `git add .`.
- Before committing, run `git status` and verify you are only staging your files.
- Message format: `{feat,fix,docs}[(ai,tui,agent,coding-agent)]: <commit message> (optionally multiple lines)`. Message is informative and concise.

## Agent skills

### Issue tracker

Issues and PRDs live in GitHub Issues; external PRs are not a triage request surface. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the default five-label triage vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Use a single-context domain documentation layout: root `CONTEXT.md` with ADRs under `docs/adr/`, both created lazily when needed. See `docs/agents/domain.md`.
