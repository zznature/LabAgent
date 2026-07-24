---
status: accepted
---

# Focus-plane calibration precedes mapping

Raman focus-plane correction uses two separately approved Bounded Runs: a calibration run first follows approved Progressive XY Waypoints, performs coarse-to-fine autofocus within a ±100 µm envelope at five anchors (four user-specified corners plus their derived center; by default a 1000 µm square centered on the current XY position), and publishes an immutable Focus-Plane Model; only then may a mapping ProcedureSpec reference that model, freeze each Predicted Focus Z, and use a ±40 µm Local Focus Correction per point. Calibration and fitting never occur inside the mapping hot path, because doing so would mutate the approved execution geometry and weaken pause, resume, safety validation, and evidence provenance.

## Decision

- Preserve the user-provided corner order as stable `corner_1..4` identities; do not reinterpret them as compass directions.
- Reject duplicate, zero-area, concave, or three-vertex-hull corner sets.
- Derive center as the arithmetic mean of the four corners.
- Freeze absolute anchors in the calibration proposal. The runtime never rereads current XY to redefine the region.
- Freeze the proposal-time current XY as `startPosition`, and insert deterministic finite waypoints from it onward so every XY leg is no longer than `maxXySpanUm`.
- Autofocus at every waypoint, but fit only the five named anchors.
- Recover the next calibration Z seed from persisted accepted autofocus evidence.
- Publish `raman-focus-plane` with anchors, coefficients, residual metrics, valid convex region, calibration run/spec provenance, and SHA-256.
- Require mapping to freeze and validate `{ calibrationRunId, artifactId, checksum }` and the exact coefficients.
- Reject mapping points outside the calibrated convex region.
- Validate the entire ±100 µm calibration or ±40 µm mapping autofocus window against hard Z limits before motion.
- Require new mapping proposals to attach a focus-plane artifact by default; an uncorrected mapping must record `surfaceCorrection.kind = disabled` with `reason = user_declined`.

## Consequences

Calibration completion authorizes no mapping motion. A mapping run needs its own bounded approval. Resume and cross-run use rely on persisted artifacts rather than process memory, and any changed or missing model fails closed.
