# LabAgent

LabAgent adapts pi-agent for in-lab research workflows. The first product slice is an MVP for Raman experiment research, where an agent turns a user's research goal into an executable experiment plan that a deterministic kernel can run.

## Language

**LabAgent**:
The project that adapts pi-agent for laboratory research workflows, with the agent assisting planning, operation, observation, and result feedback.
_Avoid_: lab automation platform, general research assistant

**Experiment Research Extension**:
The MVP product slice that adapts LabAgent to in-lab experiment research workflows, starting with Raman experiments.
_Avoid_: lab plugin, Raman-only agent

**Raman Experiment**:
A laboratory experiment workflow centered on Raman spectroscopy, including planning, controlled operation, observation, and interpretation of produced artifacts.
_Avoid_: scan, measurement

**ExperimentIntent**:
The user's research intent for an experiment, including the goal, hypothesis, constraints, and the question this round should answer.
_Avoid_: prompt, request, task

**ProcedureSpec**:
The declarative experiment plan produced by the agent and reviewed before execution. It describes what experimental procedure should be run without becoming a script or a stream of driver commands.
_Avoid_: script, workflow code, driver command list

**RunState**:
The runtime truth for an executing or completed run, including progress, current position in execution, interruptions, errors, and artifact references.
_Avoid_: plan, spec, intent

**Kernel**:
The deterministic execution owner that validates a ProcedureSpec, expands it into execution units, runs those units through the runtime, and maintains RunState.
_Avoid_: planner, agent, driver

**ExecutionUnit**:
The smallest kernel-owned execution block that provides stable progress, pause, resume, and artifact naming boundaries for a run.
_Avoid_: driver command, Python step

**Runtime**:
The layer that turns semantic execution actions into device-level behavior and returns structured results to the kernel.
_Avoid_: kernel, planner, hardware script

**Driver**:
The device-specific code that talks to real or simulated hardware under the runtime's control.
_Avoid_: tool, procedure, experiment action

**Instrument**:
A physical laboratory resource that can produce observations or accept controlled actions during an experiment.
_Avoid_: tool, plugin

**Semantic Experiment Action**:
An experiment-level action such as moving to a point, focusing, acquiring a spectrum, or performing a mapping step.
_Avoid_: serial command, SDK call, file bridge operation

**Artifact**:
A persisted output produced or referenced by a run, such as a spectrum, image, log, or summary needed for review and later analysis.
_Avoid_: result, output file

**Bounded Run**:
A supervised execution of one approved ProcedureSpec whose execution scope is frozen before the kernel starts running it.
_Avoid_: session, job

**Live-Supervised Run**:
A run mode where a human supervises the experiment while the kernel executes approved actions and the system keeps pause or abort available.
_Avoid_: autonomous run, unattended run

**Preflight**:
The checks performed before starting a run to decide whether the ProcedureSpec, resources, and current lab state are ready for execution.
_Avoid_: validation, approval

**Focus-Plane Calibration Run**:
A separately approved Bounded Run that freezes four corner anchors plus their arithmetic center, follows finite progressive XY waypoints, autofocuses within a ±100 µm coarse-to-fine envelope, and publishes one immutable Raman Focus-Plane Artifact.
_Avoid_: mapping warm-up, hidden pre-scan

**Raman Focus-Plane Artifact**:
The immutable calibration evidence and fitted model `z = a*x + b*y + c`, identified across runs by calibration run ID, artifact ID, and checksum.
_Avoid_: mutable calibration state, daemon memory

**Predicted Focus Z**:
The Z coordinate computed from an approved Raman Focus-Plane Artifact for a mapping XY point and frozen into its ExecutionUnit before motion.
_Avoid_: autofocus result, guessed Z

**Local Focus Correction**:
The mapping-time autofocus search restricted to ±40 µm around Predicted Focus Z.
_Avoid_: recalibration, global focus search
