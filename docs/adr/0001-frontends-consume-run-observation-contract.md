# Frontends consume the Run Observation Contract

Frontends obtain experiment progress and results through a backend/API Run Observation Contract rather than scanning `lab-records` or interpreting file names. The filesystem remains the persistence and debugging substrate, while the backend owns the stable presentation boundary so storage layout, partial writes, retries, and deployment paths do not leak into frontend behavior.
