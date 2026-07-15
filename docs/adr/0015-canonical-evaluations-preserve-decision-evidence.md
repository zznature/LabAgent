# Canonical evaluations preserve decision evidence

The `raman-evaluation` profile has one versioned JSON `data` representation containing rule-set identity and version, input artifact IDs and metrics, applied thresholds, per-rule comparisons, final decision, and reasons. It references inputs from the same execution attempt and is immutable after completion; later configuration or rule changes do not overwrite or silently recompute the historical decision.
