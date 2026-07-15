# Run observation uses snapshots and ordered events

The Run Observation Contract provides both a complete current snapshot and a run-local ordered event feed. Every observation event has a monotonic sequence, allowing a frontend to reconnect from its last acknowledged sequence without timestamp-based deduplication. Initial loading and recovery use the snapshot; live progress uses events after a cursor. Polling, SSE, or WebSocket transport may vary without changing this contract.
