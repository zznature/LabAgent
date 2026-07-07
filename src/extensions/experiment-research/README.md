# Experiment Research Extension

This directory is the canonical path for the LabAgents MVP rebuild.

Current status:

- prompt layering is fixed as:
  `core lab agent prompt -> Raman extension prompt -> lab-local user prompts`
- Phase 10 bounded Raman parameter search and bounded Raman mapping execution are implemented on top of the planner proposal flow, explicit evaluation rules, simulation runtime, registered live runtime contract, and approval gate
- planner-facing tools:
  - `get_lab_capabilities`
  - `get_lab_state`
  - `validate_procedure_spec`
  - `run_preflight`
- operator-facing tools:
  - `raman_get_hardware_status`
  - `raman_get_stage_position`
  - `raman_stage_move_relative`
- core schema modules available under `schemas/`:
  - `experiment-intent.ts`
  - `procedure-spec.ts`
  - `execution-unit.ts`
  - `run-state.ts`
  - `tool-result.ts`
- persistence store modules available under `store/`:
  - `intent-store.ts`
  - `procedure-spec-store.ts`
  - `run-store.ts`
  - `event-store.ts`
  - `artifact-store.ts`
- kernel compile module available under `kernel/`:
  - `compile-units.ts`
- simulation runtime modules available under `kernel/` and `runtime/`:
  - `run-controller.ts`
  - `simulation-runtime.ts`
- proposal + simulation tools available:
  - `propose_run`
  - `approve_and_start_run`
  - `run_procedure`
  - `poll_run`
  - `pause_run`
  - `abort_run`
- `approve_and_start_run` can now execute:
  - simulation bounded runs
  - live-supervised Raman single-point bounded runs when a live runtime is registered
  - live-supervised Raman parameter-search bounded runs when a live runtime is registered
  - live-supervised Raman grid-mapping bounded runs when a live runtime is registered
- bounded parameter search now enforces:
  - approved search envelope only
  - max attempts
  - explicit rule-based early stop vs operator-decision pause
- bounded mapping now supports:
  - compiled `grid_scan` point execution
  - progress with completed and failed point counts
  - configurable consecutive-failure stop without auto-expanding the grid or auto-changing parameters
- `run_procedure` remains registered as a deprecated blocked entrypoint that returns `approval_required`
- planner builders available under `planner/`:
  - `intent-builder.ts`
  - `procedure-spec-builder.ts`
  - `evaluate-good-enough.ts`
- Raman runtime contract modules available under `runtime/raman/`:
  - `resources.ts`
  - `actions.ts`
  - `live-runtime.ts`
  - `python-runtime.ts` (persistent Python hardware daemon client)
  - `index.ts`
- the live Python hardware driver entrypoint lives at the deployed workspace
  copy `lab-config/drivers/raman-python/raman_runtime_daemon.py` (product
  source: `src/drivers/raman-python/`)
- operator reads, active probes, and stage nudges use the registered Raman live
  runtime directly. They do not require a Raman `ProcedureSpec`; each tool only
  touches the resource it needs.

## Prompt Layers

The current LabAgents prompt surface is intentionally three layers:

```text
core lab agent prompt
  -> src/extensions/experiment-research/prompt.ts
  -> workspace lab-config/user-prompts.md
```

- `src/prompts/APPEND_SYSTEM.md` is the core Lab Agent prompt selected by
  `deploy/run-labagents.*`. It owns the general lab identity, startup behavior,
  and non-domain execution boundary.
- `src/extensions/experiment-research/prompt.ts` is the Raman extension prompt.
  It owns Raman-specific tool routing, bounded `ProcedureSpec` workflow, and
  Raman run constraints.
- workspace `lab-config/user-prompts.md` is the lab-local prompt. It lives with
  the lab-specific Raman configuration and owns local operating defaults such as
  the active lab domain, configured runtime path, and record traceability
  expectations.

Keep hard execution boundaries out of `user-prompts.md`; they belong in the core
or Raman extension prompt so local notes cannot dilute them.

## Live Raman Runtime Configuration

The rebuild loads stable lab hardware context at session start. Runtime config
resolution is:

```text
lab-config/raman-runtime.local.json
> lab-config/raman-runtime.lab.json
> no live runtime
```

`raman-runtime.lab.json` is the committed lab default. `raman-runtime.local.json`
is a git-ignored local override for temporary port/path/enablement changes.

Current lab default:

```json
{
  "enabled": true,
  "pythonExecutable": "python",
  "pythonRoot": "lab-config/drivers/raman-python",
  "stage": {
    "resourceId": "stage-main",
    "kind": "stage",
    "runtime": "raman_python",
    "driver": "mc_newton_xyz",
    "config": {
      "port": "COM17",
      "xChannel": 1,
      "yChannel": 2,
      "zChannel": 3,
      "baudrate": 115200
    },
    "leasePolicy": "exclusive",
    "simulationAvailable": true,
    "limits": {
      "xRangeUm": [0, 50000],
      "yRangeUm": [0, 50000],
      "zRangeUm": [0, 5000]
    }
  },
  "frameProvider": {
    "resourceId": "frame-main",
    "kind": "frame_provider",
    "runtime": "raman_python",
    "driver": "labspec_file_bridge_frame",
    "config": {
      "bridgeDir": "D:\\RamanLab\\SpecBridge",
      "imageFormat": "tif",
      "minCaptureIntervalMs": 400
    },
    "leasePolicy": "shared-read",
    "simulationAvailable": false
  },
  "spectrometer": {
    "resourceId": "spectrometer-main",
    "kind": "spectrometer",
    "runtime": "raman_python",
    "driver": "labspec_file_bridge_spectrum",
    "config": {
      "bridgeDir": "D:\\RamanLab\\SpecBridge",
      "requestFilename": "spectrum_request.ini",
      "resultFilename": "spectrum_result.ini"
    },
    "leasePolicy": "exclusive",
    "simulationAvailable": false
  },
  "preflight": {
    "requirePythonRoot": true,
    "requireBridgeDirs": false,
    "connectStage": true
  }
}
```

Set `"enabled": false` in `raman-runtime.local.json` to keep hardware disabled
explicitly on one machine. Without an enabled registered runtime,
live-supervised `approve_and_start_run` returns `live_runtime_unavailable`;
simulation remains available.

The committed lab default lives at:

```text
lab-config/raman-runtime.lab.json
```

## Live Raman Runtime Transport (Persistent Daemon)

The Python live runtime talks to one long-lived hardware daemon instead of
spawning a fresh process per action:

```text
lab-config/drivers/raman-python/raman_runtime_daemon.py
```

`createRamanPythonRuntime` spawns this script lazily on the first action and
keeps it alive, so a multi-point mapping run connects to the stage and LabSpec
frame bridge once instead of reconnecting on every move/autofocus/frame/spectrum
action. Properties relevant to mapping reliability:

- **One persistent session.** Stage and frame-provider sessions are opened on
  first use and reused for the whole run. Stage channels are disabled after each
  motion (no axis left energized between actions), but the serial connection
  stays open.
- **Serialized access.** All actions and operator tools share one daemon and are
  queued one-at-a-time, so the single hardware session is never touched
  concurrently. This is a transport-level correctness guarantee, not a policy
  lease (multi-agent lease arbitration remains a target-state item).
- **Timeout recovery.** A timed-out action kills and resets the daemon; the next
  action respawns it. Hard safety limits (motion bounds, objective clearance,
  laser power) are still enforced in TypeScript before each action regardless of
  transport.
- **Idle release.** After `daemon.idleShutdownMs` (default 30000 ms) with no
  action, the daemon shuts down cleanly and releases the serial port so other
  lab software can use it; the next action respawns it.

Optional config (in `raman-runtime.lab.json` / `raman-runtime.local.json`):

```json
{
  "daemon": { "idleShutdownMs": 30000 }
}
```

## Tests

Rebuild-specific tests live in:

```text
src/extensions/experiment-research/test/
```

Run them from the repository root with:

```bash
npm test
```

The previous reference implementation has been deleted. This extension is the sole MVP implementation baseline.
