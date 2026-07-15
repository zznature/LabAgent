# Run snapshots include all unit summaries

The MVP Run Observation Snapshot includes a summary for every ExecutionUnit so the frontend can render a complete mapping grid and progress state without per-point requests. Each summary carries stable unit identity and index, point coordinates when applicable, status, active and accepted attempt IDs, attempt count, canonical artifact IDs, and timing. Full artifact descriptors remain available through artifact APIs rather than being embedded in the snapshot.
