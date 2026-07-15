# Progress is not an artifact

Run progress is represented by the Run Observation Snapshot and ordered Run Observation Events, while experimental outputs are represented by Artifact Descriptors. Frontends must not infer completed units, attempts, or points from file or artifact counts. This keeps progress observable when an action produces no file and prevents diagnostic files or retries from inflating progress.
