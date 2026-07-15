# Use versioned artifact descriptors

Every artifact exposed through the Run Observation Contract uses a fixed common envelope plus a versioned, kind-specific data schema. The common envelope records artifact identity, run/unit/attempt/action provenance, kind, completion status, media type, location, creation time, and size. Frontends consume this contract instead of interpreting arbitrary metadata or driver-specific payloads.
