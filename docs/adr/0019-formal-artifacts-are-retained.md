# Formal artifacts are retained

The MVP never automatically deletes formal source or canonical artifacts. Runtime may clean bridge or daemon staging files only after the formal copy is complete, its size and checksum are recorded, canonical schemas are validated, and descriptor and index publication succeeds. Any future retention or deletion policy must be explicit and auditable rather than an incidental driver cleanup behavior.
