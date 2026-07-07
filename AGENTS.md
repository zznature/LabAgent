# Development Rules

Goal: Maintain LabAgents as the product repository for Raman lab research agents.
The pi runtime is an upstream dependency pinned in `package.json`; product code
belongs here, while deployment workspaces contain only local configuration,
records, and experiment artifacts.

Implementation should always follow `docs/design-ideas/core-ideas.md`.
- When implementation may go beyond the design, ask the user to improve it.
- Agent can only edit that design document with the user's direct order.
- Tech docs in `docs/design-ideas/` should reflect the actual implementation.

## First Principles

- Keep the product boundary explicit: pi runtime, LabAgents product repo, lab
  workspace.
- Prefer semantic experiment tools over exposing low-level hardware details.
- Guardrail is a pi-tool boundary, not an OS sandbox or hardware safety system.
- Hardware safety belongs in semantic validation, runtime admission, kernel
  execution, and driver limits.

## Commands

- After code changes: `npm run check`.
- If a test file changes: run `npm test` or the specific vitest file.
- Do not run real hardware tests unless the user asks and the lab operator is
  ready.
