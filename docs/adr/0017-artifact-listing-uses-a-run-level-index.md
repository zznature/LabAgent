# Artifact listing uses a run-level index

Each run maintains an atomically updated, revisioned `artifact-index.json` projection for artifact listing and filtering. Backend APIs query this projection rather than scanning artifact directories. The index records artifact identity, lifecycle, profile, unit and attempt ownership, and descriptor location; it is rebuildable from ordered Run Observation Events and completed artifact descriptors, so it does not replace the self-contained artifact records.
