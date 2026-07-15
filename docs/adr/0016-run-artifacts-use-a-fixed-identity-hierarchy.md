# Run artifacts use a fixed identity hierarchy

Attempt-scoped artifacts are stored under `lab-records/runs/<runId>/artifacts/units/<unitId>/attempts/<attemptId>/<artifactId>/`. Each artifact directory contains `descriptor.json` and a `representations/` directory with only the profile-defined files it provides. Run, unit, attempt, and artifact IDs are immutable path-safe segments. Source and canonical artifacts have separate identities and link through provenance rather than sharing or overwriting files.
