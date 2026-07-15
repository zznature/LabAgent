# Observation projections use event sequences

Run Observation Snapshots and artifact indexes record `throughSequence`, the highest run-local observation event incorporated into the projection. They do not maintain unrelated revision counters. Frontends load a snapshot and continue from its sequence; backend APIs ensure indexes are caught up before returning them, and transport cache validators may derive from run ID and sequence.
