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

**Run Progress**:
The observable advancement of a Bounded Run across its ExecutionUnits and Execution Attempts, independent of how many artifacts have been produced.
_Avoid_: artifact count, file count, directory contents

**Run Observation Contract**:
The stable boundary through which an external observer accesses a run's progress, status, and artifact references without depending on how experiment files are stored.
_Avoid_: directory scan, file naming convention, filesystem API

**Run Observation Snapshot**:
The complete current observation of a Bounded Run, used for initial loading and recovery when an observer's incremental state is missing or uncertain.
_Avoid_: event history, cached directory listing, inferred state

**Run Observation Event**:
An ordered incremental change within a Bounded Run's observation history, identified by a run-local monotonic sequence.
_Avoid_: timestamp update, log line, filesystem notification

**Kernel**:
The deterministic execution owner that validates a ProcedureSpec, expands it into execution units, runs those units through the runtime, and maintains RunState.
_Avoid_: planner, agent, driver

**ExecutionUnit**:
The smallest kernel-owned execution block that provides stable progress, pause, resume, and artifact naming boundaries for a run.
_Avoid_: driver command, Python step

**Execution Attempt**:
One immutable attempt to execute an ExecutionUnit within its Bounded Run. A retry or resumed re-execution creates a new attempt without replacing the evidence from earlier attempts.
_Avoid_: retry run, latest result, overwritten result

**Accepted Attempt**:
The Execution Attempt explicitly selected by the Kernel as the authoritative outcome of an ExecutionUnit. It is not inferred from attempt order, timestamps, or file modification time.
_Avoid_: latest attempt, newest result, last directory

**Runtime**:
The layer that turns semantic execution actions into device-level behavior and returns structured results to the kernel. It owns the acceptance of Canonical Artifacts produced by those actions.
_Avoid_: kernel, planner, hardware script

**Driver**:
The device-specific code that talks to real or simulated hardware under the runtime's control.
_Avoid_: tool, procedure, experiment action

**Instrument**:
A physical laboratory resource that can produce observations or accept controlled actions during an experiment.
_Avoid_: tool, plugin

**Verified Instrument State**:
An Instrument state supported by device or worker evidence, distinct from a state merely requested by an action.
_Avoid_: requested state, assumed state, intended state

**Semantic Experiment Action**:
An experiment-level action such as moving to a point, focusing, acquiring a spectrum, or performing a mapping step.
_Avoid_: serial command, SDK call, file bridge operation

**Artifact**:
A persisted output produced or referenced by a run, such as a spectrum, image, log, or summary needed for review and later analysis.
_Avoid_: result, output file

**Artifact Descriptor**:
A versioned, structured description of an Artifact that fixes its identity, run/unit/attempt/action provenance, kind, completion status, media type, location, and kind-specific data contract.
_Avoid_: arbitrary metadata bag, path-only reference, driver payload

**Source Artifact**:
An immutable Artifact preserved in the format produced by an instrument or device-specific driver as the original experimental evidence.
_Avoid_: canonical file, frontend format, temporary file

**Canonical Artifact**:
A normalized Artifact with a stable format and schema intended for observation, comparison, and presentation independently of the producing instrument. It retains provenance linking it to its Source Artifacts.
_Avoid_: raw file, driver output, disposable preview

**Canonical Artifact Profile**:
A versioned contract for one kind of Canonical Artifact, defining the scientific meaning and presentation data that observers may rely on.
_Avoid_: file extension, driver result type, arbitrary artifact kind

**Scientific Axis**:
A calibrated data dimension whose physical meaning and unit are explicit, such as Raman shift in inverse centimetres or intensity in counts.
_Avoid_: x values, y values, column one, assumed units

**Artifact Representation**:
One profile-defined encoding of a logical Artifact for a specific role such as data, display, thumbnail, or download. Multiple representations share one Artifact Descriptor and do not become separate experimental results.
_Avoid_: duplicate artifact, arbitrary attachment, untyped file

**Artifact Lifecycle**:
The observable completeness state of an Artifact: pending, producing, complete, or failed. Only a complete Artifact is valid for reading or presentation.
_Avoid_: file exists, newest file, probably finished

**Run Artifact Scope**:
The complete artifact boundary of one Bounded Run. Artifacts produced before and after pause, resume, or retry remain part of the same scope identified by the original run ID.
_Avoid_: procedure artifact folder, daemon session folder, retry run

**Bounded Run**:
A supervised execution of one approved ProcedureSpec whose execution scope is frozen before the kernel starts running it.
_Avoid_: session, job

**Live-Supervised Run**:
A run mode where a human supervises the experiment while the kernel executes approved actions and the system keeps pause or abort available.
_Avoid_: autonomous run, unattended run

**Operator Operation**:
A bounded maintenance or observation action initiated outside a Bounded Run, with its own identity and artifact scope. It may reference a related run without becoming part of that run's accepted experimental result.
_Avoid_: implicit run step, latest-run action, maintenance run

**Preflight**:
The checks performed before starting a run to decide whether the ProcedureSpec, resources, and current lab state are ready for execution.
_Avoid_: validation, approval
