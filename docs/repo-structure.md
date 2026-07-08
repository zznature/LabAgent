# LabAgents Repository Structure

This document defines the file-structure boundaries for the LabAgents product
repository and the generated Raman lab workspace.

## First Principles

LabAgents separates three filesystem roles:

1. **Product source** (`src/`): all code and prompts maintained by LabAgents
   developers, released as one unit.
2. **Deployment layer** (`deploy/`): scripts and templates that generate a lab
   workspace from product source.
3. **Lab workspace** (generated, outside this repo): the runtime cwd used by
   the agent on a lab machine. It holds lab-local configuration
   (`lab-config/`) and run outputs (`lab-records/`), never product source.

The lab workspace is not the source-of-truth product repository. The agent's
guardrail confines tool access to the workspace and blocks the product repo.

## Repository Layout

```text
labagents/
  src/                          # all product source in one place
    extensions/
      experiment-research/      # semantic Raman planning, operator, runtime tools
      guardrail/                # pi tool-level workspace boundary checks
    drivers/
      raman-python/             # Raman Python driver: daemon, stage, autofocus,
                                #   mapping, vendor SDK assets
    prompts/
      APPEND_SYSTEM.md          # core Lab Agent system prompt

  deploy/                       # deployment scripts and workspace templates
    setup-workspace.sh / .ps1   # generate or refresh a lab workspace
    run-labagents.sh / .ps1     # start the pinned pi runtime from the workspace
    smoke-mac.mjs               # verifies the deployment boundary
    templates/
      lab-workspace/
        .pi/
          settings.json.template
          labagents-policy.json.template
        lab-config/
          raman-runtime.lab.json.template
          raman-runtime.local.json.example
          user-prompts.md

  docs/
    design-ideas/               # design guidance (core-ideas.md is the guide)
    repo-structure.md

  package.json                  # pins the pi runtime dependency
  package-lock.json
  tsconfig.json
```

### `src/`

All product source lives under `src/` so a release is a single directory:

- `src/extensions/` — product TypeScript extensions loaded by pi. The lab
  workspace references them through absolute paths in `.pi/settings.json`; it
  never copies or modifies them as workspace state.
- `src/drivers/raman-python/` — the Raman Python driver source. It is
  product-maintained code; `setup-workspace.*` copies it into the workspace as
  a deployment artifact (see below).
- `src/prompts/` — product prompts shared across deployments.
  `APPEND_SYSTEM.md` is passed to pi by `deploy/run-labagents.*`.

### `deploy/`

Everything needed to create and run a lab deployment:

- `setup-workspace.*` renders the templates into a target workspace, creates
  `lab-config/` and `lab-records/`, and refreshes the deployed driver copy at
  `lab-config/drivers/raman-python/`. It never overwrites an existing
  `raman-runtime.local.json` or `user-prompts.md`.
- `run-labagents.*` starts the pinned local pi binary with cwd set to the lab
  workspace.
- `smoke-mac.mjs` verifies the generated workspace: extension paths, policy
  root, driver copy, guardrail blocking, and record writes.

## Generated Lab Workspace

```text
RamanLabWorkspace/
  .pi/                          # agent runtime wiring (generated)
    settings.json               # absolute paths to src/extensions/*
    labagents-policy.json       # guardrail workspace + protected roots

  lab-config/                   # 2. all lab-local configuration in one place
    raman-runtime.lab.json      # committed lab default (relative pythonRoot)
    raman-runtime.local.json    # git-ignored local override
    user-prompts.md             # lab-local prompt layer
    drivers/
      raman-python/             # deployed driver copy (refreshed by setup)

  lab-records/                  # 3. all run outputs in one place
    experiments/                # intents, procedure specs, planned output
    runs/                       # run state, events, artifacts
```

In this model:

- `src/drivers/raman-python/` is the product source; the workspace copy at
  `lab-config/drivers/raman-python/` is the deployment artifact.
- `raman-runtime.lab.json` sets `pythonRoot` to the workspace-relative path
  `lab-config/drivers/raman-python`, so the workspace runs without depending
  on mutable repo paths.
- `lab-records/` is where the extension stores everything the agent produces:
  experiment intents, frozen procedure specs, run state, events, and
  artifacts (spectra, frames, plots, evaluations).
- Guardrail still protects the LabAgents product repo and the pi repo; the
  agent works only inside the workspace.

## Why Copy the Driver Into the Workspace?

The Raman Python driver sits between source code and runtime artifact:

- It is maintained as product source in LabAgents.
- It is executed on the lab machine as part of the hardware runtime.
- It may need to run offline and remain stable for a specific lab deployment.

Copying it into `lab-config/drivers/` gives a clean release boundary:

- The lab workspace runs without depending on mutable source paths.
- Each workspace captures the driver version it was prepared with.
- Product source remains protected from agent tool access.
- Lab configuration and its driver deployment travel together.

Re-running `setup-workspace.*` refreshes the copy after a product upgrade.

## Boundary Rules

Use these rules when adding or moving files:

- Product TypeScript extension code belongs under `src/extensions/`.
- Product Python driver source belongs under `src/drivers/raman-python/`.
- Product prompts belong under `src/prompts/`.
- Deployment templates and scripts belong under `deploy/`.
- Lab-local configuration belongs under workspace `lab-config/`.
- Deployed driver copies belong under workspace `lab-config/drivers/`.
- Experiment records and run artifacts belong under workspace `lab-records/`.
- Design guidance belongs under `docs/design-ideas/`.
