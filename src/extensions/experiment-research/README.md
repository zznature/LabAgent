# Experiment Research Extension

This directory is the canonical path for the LabAgents MVP rebuild.

Current status:

- prompt layering is fixed as:
  `core lab agent prompt -> Raman extension prompt -> lab-local user prompts`
- bounded Raman parameter search, mapping, and temperature-series execution are implemented on top of the planner proposal flow, explicit evaluation rules, simulation runtime, registered live runtime contract, and approval gate
- planner-facing tools:
  - `get_lab_capabilities`
  - `get_lab_state`
  - `validate_procedure_spec`
  - `run_preflight`
- operator-facing tools:
  - `raman_get_hardware_status`
  - `raman_get_stage_position`
  - `raman_stage_move_relative`
  - `raman_get_temperature_status`
  - `raman_set_temperature_target`
  - `raman_stop_temperature_control`
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
  - live-supervised Raman temperature-series bounded runs when a temperature controller is registered
- bounded parameter search now enforces:
  - approved search envelope only
  - max attempts
  - explicit rule-based early stop vs operator-decision pause
- bounded mapping now supports:
  - compiled `grid_scan` point execution
  - progress with completed and failed point counts
  - configurable consecutive-failure stop without auto-expanding the grid or auto-changing parameters
- bounded temperature series now supports:
  - one stable execution unit per target temperature
  - user-overridable stability tolerance, continuous hold, post-stable dwell, and timeout
  - temperature evidence immediately before and after each spectrum
  - one bounded reacquisition after excessive drift, followed by `completed_with_failures` while later targets continue
  - autofocus only when explicitly enabled; its default is off
  - persistent target/output across completion, failure, pause, abort, and daemon shutdown; only `raman_stop_temperature_control` turns output off
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
lab-config/raman-runtime.lab.json
+ lab-config/raman-runtime.local.json overrides
> no live runtime
```

`raman-runtime.lab.json` is the committed lab default. `raman-runtime.local.json`
is a git-ignored local override for temporary port/path/enablement changes. The
local file is merged over the lab default, so a machine can override only fields
such as `pythonExecutable`, `stage.config.port`, or LabSpec bridge directories.
Set `"enabled": false` in local config to explicitly disable live hardware on
one machine.

Current lab default:

```json
{
  "enabled": true,
  "pythonExecutable": "C:\\RamanLab\\RamanLabWorkspace\\.venv\\Scripts\\python.exe",
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
  "temperatureController": {
    "resourceId": "temperature-main",
    "kind": "temperature_controller",
    "runtime": "raman_python",
    "driver": "kelvinion_mini",
    "config": {
      "port": "COM6",
      "baudrate": 115200,
      "channel": "A",
      "controlMode": "A",
      "outputRange": "LOW",
      "defaultRampKPerMin": 5
    },
    "leasePolicy": "exclusive",
    "simulationAvailable": true,
    "operatingRange": {
      "minTargetK": 50,
      "maxTargetK": 350,
      "maxRampKPerMin": 10
    }
  },
  "preflight": {
    "requirePythonRoot": true,
    "requireBridgeDirs": false,
    "connectStage": true
  }
}
```

Use an absolute workspace-local `pythonExecutable` path. The deployment template
renders it as `<workspace>\\.venv\\Scripts\\python.exe`; local config can still
override it for a machine-specific environment. Without an enabled registered
runtime, live-supervised `approve_and_start_run` returns `live_runtime_unavailable`;
simulation remains available.

Edit `temperatureController.config.port` for the connected controller. The
configured operating range and ramp ceiling are device-capability admission
bounds and should also be adjusted to the installed controller/cryostat.

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
  action, the daemon shuts down cleanly and releases serial ports so other lab
  software can use them; the next action respawns it. Disconnecting never sends
  temperature OFF, so the controller retains its current target and output.

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

Run only this extension's tests from `src/extensions/experiment-research` with:

```bash
node ../../../node_modules/vitest/dist/cli.js --run test
```

The previous reference implementation has been deleted. This extension is the sole MVP implementation baseline.
