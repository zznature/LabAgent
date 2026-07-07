# LabAgents

LabAgents is the Raman lab product layer for pi. The pi runtime is consumed as a
fixed npm dependency; this repository owns the product source (`src/`), the
deployment layer (`deploy/`), design notes, and product tests. See
`docs/repo-structure.md` for the full layout.

## Install

```sh
npm install --ignore-scripts
npm run check
npm test
```

## Setup a Lab Workspace

The agent must run from a workspace that does not contain product source code.

```sh
deploy/setup-workspace.sh /path/to/RamanLabWorkspace
```

The setup script creates `.pi/settings.json`, `.pi/labagents-policy.json`, the
`lab-config/` configuration directory (runtime configs, user prompts, and the
deployed Raman Python driver copy), and the `lab-records/` output directory.
It does not overwrite `lab-config/raman-runtime.local.json` or
`lab-config/user-prompts.md`; re-running it refreshes the driver copy.

## Run

```sh
deploy/run-labagents.sh /path/to/RamanLabWorkspace
```

The run script launches the locally installed, pinned `pi` binary from this
repository and changes cwd to the lab workspace before starting the agent.

## Upgrade pi

1. Pin the new exact `@earendil-works/pi-coding-agent` version in `package.json`.
2. Run `npm install --package-lock-only --ignore-scripts`.
3. Run `npm run check`, `npm test`, and `npm run smoke:mac`.
4. Re-run a Windows lab-machine smoke before deploying to the Raman computer.

## Product Boundary

- `src/extensions/experiment-research` exposes semantic Raman planning and
  runtime tools.
- `src/extensions/guardrail` blocks pi tool access outside the lab workspace.
- `src/drivers/raman-python` contains the Raman Python runtime bridge; setup
  deploys a copy into workspace `lab-config/drivers/raman-python`.
- `deploy/templates/lab-workspace` defines deployable workspace files.
- Workspace `lab-config/` holds lab-local configuration; `lab-records/` holds
  agent-generated intermediate outputs and experiment results.
- `docs/design-ideas/core-ideas.md` remains the implementation guide.
