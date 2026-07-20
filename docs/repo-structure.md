# LabAgent Repository Structure

This document describes the repository as it exists today, the generated Raman
lab workspace, and the boundary between implemented code and proposed design.

## First Principles

LabAgent separates four filesystem roles:

1. **Product source** (`src/`): TypeScript extensions, prompts, and Python
   drivers maintained and released together.
2. **Deployment layer** (`deploy/`): scripts and templates that create or
   refresh a lab workspace.
3. **Product documentation** (`docs/`): current design guidance, accepted
   decisions, and proposals that are not yet implementation truth.
4. **Lab workspace** (generated outside this repo): the runtime cwd on a lab
   machine. It holds lab-local configuration and experimental records, never
   editable product source.

The workspace is the agent's operational boundary. Guardrail confines agent
tools to that workspace and protects the LabAgent and pi source repositories.

## Repository Layout

```text
labagent/
  src/
    extensions/
      experiment-research/       # Raman MVP planning and execution extension
        kernel/                   # deterministic bounded-run controller
        planner/                  # intent/spec construction and evaluation rules
        records/                  # run observation and artifact contract
        runtime/                  # simulation and Raman runtime adapters
        schemas/                  # persisted and tool-facing domain schemas
        store/                    # workspace filesystem persistence
        test/                     # extension contract and integration tests
        tools/                    # planner, runtime, and operator pi tools
        index.ts                  # extension composition root
        prompt.ts                 # Raman-specific agent instructions
    guardrail/                    # pi tool-level workspace access policy

    drivers/
      raman-python/
        raman_runtime_daemon.py   # persistent JSON-lines hardware worker
        stage/                    # MCNewton and in-memory stage adapters
        autofocus/                # focus algorithms and LabSpec frame bridge
        mapping/                  # Raman mapping and spectrum utilities
        vendor/                   # pinned vendor SDK asset

    prompts/
      APPEND_SYSTEM.md            # core LabAgent system prompt

  deploy/
    setup-workspace.sh / .ps1     # create or refresh a lab workspace
    sync-driver.ps1               # product driver -> workspace
    sync-driver-back.ps1          # workspace driver -> product source (dev only)
    run-labagents.sh / .ps1       # start pinned pi in the workspace
    smoke-mac.mjs                 # verify deployment and guardrail boundaries
    templates/lab-workspace/
      .pi/                        # pi settings and guardrail policy templates
      lab-config/                 # runtime config, procedure templates, prompts

  docs/
    adr/                          # accepted run observation/artifact decisions
    agents/                       # issue tracker, triage, and domain-doc rules
    design-ideas/                 # current user-guided technical design
    proposals/                    # proposed designs, not implementation truth
    repo-structure.md
    release-workflow.md

  CONTEXT.md                      # current ubiquitous language
  AGENTS.md                       # repository development rules
  package.json                    # scripts and pinned pi runtime dependency
  package-lock.json
  tsconfig.json
```

Generated caches such as `__pycache__/`, `node_modules/`, and `.DS_Store` are
not architectural parts of the repository.

## Experiment Research Extension

`src/extensions/experiment-research/` is the sole MVP implementation baseline.
Its current implementation is Raman-specific at the runtime edge, while its
schemas, kernel, records, and stores establish reusable experiment concepts.

### Composition and tools

- `index.ts` registers prompt context, runtime adapters, and pi tools.
- `tools/planner.ts` exposes intent, capability, template, validation, preflight,
  and proposal operations.
- `tools/runtime.ts` owns approval-gated run start, polling, summaries,
  pause, resume, and abort entrypoints.
- `tools/operator.ts` exposes bounded hardware status, stage, frame, spectrum,
  and autofocus operations outside a formal run.
- `tools/params.ts` centralizes TypeBox schemas used by tool interfaces.

### Planner and schemas

- `planner/` constructs `ExperimentIntent` and bounded Raman `ProcedureSpec`
  values and applies explicit good-enough rules.
- `schemas/` defines intents, procedure templates/specs, finite
  `ExecutionUnit`s, `RunState`, evaluations, validation, and tool results.
- The implemented `ProcedureSpec` is still compiled into a finite
  `ExecutionUnit[]`; LabFlow control flow is proposal-stage work.

### Kernel

- `compile-units.ts` expands current-position, point-list, grid-mapping, and
  bounded parameter-search plans.
- `run-admission.ts` verifies proposal approval and freezes the exact spec.
- `prepare-live-run.ts` and `validate-execution.ts` enforce live resource,
  risk, anchor, and execution-contract checks.
- `run-controller.ts` and `run-strategies.ts` execute bounded simulation or
  live-supervised runs, including retries, checkpoints, pause, abort, progress,
  and artifact acceptance.

The current `RunController` is instantiated inside the pi extension process.
Consequently, persisted `RunState` survives process exit but an active run does
not yet have an independent controller. This is an acknowledged implementation
limit, not the target architecture.

### Runtime and Python driver

- `runtime/simulation-runtime.ts` is the deterministic simulation adapter.
- `runtime/raman/` defines resources, semantic actions, live execution, and the
  TypeScript client for the Python hardware worker.
- `src/drivers/raman-python/raman_runtime_daemon.py` is a persistent,
  serialized hardware worker spawned lazily by `python-runtime.ts`.
- The Python worker owns driver sessions and releases them after its configured
  idle timeout. It does not own run admission, RunState, scheduling, or recovery.

The current Python process is therefore a **runtime daemon**, not the proposed
independent **Lab Daemon**.

### Records and persistence

- `store/` persists intents, proposals, frozen specs, run snapshots, legacy
  events, experiment templates, and artifact metadata under the workspace.
- `records/run-records.ts` implements the frontend-facing run observation
  snapshot plus ordered-event contract and fail-closed artifact publication.
- Run artifacts use stable run/unit/attempt/artifact identity and preserve
  source-to-canonical provenance.
- Operator operations have an independent artifact scope and never become an
  accepted run result implicitly.

## Generated Lab Workspace

```text
RamanLabWorkspace/
  .pi/
    settings.json                # absolute product extension paths
    labagents-policy.json        # workspace and protected-root policy

  lab-config/
    raman-runtime.lab.json       # deployed lab defaults
    raman-runtime.local.json     # optional machine-local override
    user-prompts.md              # lab-local prompt layer
    templates/                   # reusable ProcedureSpec templates
    drivers/
      raman-python/              # deployed copy of the Python driver

  lab-records/
    experiments/
      <experimentId>/
        intents/
          <intentId>.json
        proposals/
          <proposalId>.json
        procedure-specs/
          <procedureSpecId>.json

    runs/
      <runId>/
        run-state.json           # kernel-owned current snapshot
        run-observation.json     # observer-facing snapshot
        events.jsonl             # ordered observation changes
        legacy-events.jsonl      # current legacy kernel event stream
        artifacts.jsonl          # current legacy artifact stream
        artifact-index.json
        artifacts/units/
          <unitId>/attempts/<attemptId>/<artifactId>/
            descriptor.json
            representations/

    operator-operations/
      <operationId>/
        operation.json
        artifact-index.json
        artifacts/<artifactId>/
          descriptor.json
          representations/
```

The deployed `raman-runtime.lab.json` resolves `pythonRoot` relative to the
workspace, so a lab installation does not execute mutable Python files from the
product repository. `setup-workspace.*` refreshes the deployed copy but does not
overwrite existing local overrides or lab-local prompts.

## Documentation Authority

Documentation directories have different authority:

- `docs/design-ideas/core-ideas.md` is the user-authored design guide and may
  only be edited by direct user instruction.
- Other files in `docs/design-ideas/` describe the intended technical design
  and should be kept consistent with implementation when that design lands.
- `docs/adr/` records accepted decisions for the current observation and
  artifact contracts.
- `docs/proposals/` contains designs under consideration and must not be read as
  current repository behavior.

In particular, `docs/proposals/agent-native-kernel-redesign.md` proposes:

- a LabFlow program compiled to an immutable `ExecutableProgram`;
- dynamic execution invocations rather than only finite pre-expanded units;
- a local, single-user Lab Daemon that owns run lifecycle independently of pi;
- Agent, CLI, and future local UI clients using the same daemon interface;
- daemon restart recovery that waits for explicit operator action.

None of those daemon or LabFlow modules exist in `src/` yet.

## Boundary Rules

- Product TypeScript extension code belongs under `src/extensions/`.
- Product Python driver code belongs under `src/drivers/`.
- Product prompts belong under `src/prompts/`.
- Deployment scripts and templates belong under `deploy/`.
- Lab-local configuration belongs under workspace `lab-config/`.
- Deployed driver copies belong under workspace `lab-config/drivers/`.
- Experiment records and artifacts belong under workspace `lab-records/`.
- Current technical design belongs under `docs/design-ideas/`; unimplemented
  alternatives belong under `docs/proposals/`.
- Agent-facing code must not depend on scanning artifact directories; it uses
  the run observation and artifact interfaces.
- New run-lifecycle ownership must not be added to the Python runtime daemon;
  that responsibility belongs to the proposed Lab Daemon.
