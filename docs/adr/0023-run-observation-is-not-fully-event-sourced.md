# Run observation is not fully event sourced

The MVP does not make observation events the sole business truth. RunState and formal artifact records remain persisted facts, while ordered Run Observation Events provide incremental frontend updates and history. A frontend that detects a sequence gap or expired cursor reloads the current snapshot. This preserves reliable observation without expanding the MVP into a general event-sourcing and audit platform.
