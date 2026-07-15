# Artifacts have an observable lifecycle

Artifact descriptors expose `pending`, `producing`, `complete`, or `failed` status so frontends can show output progress and failures. Only `complete` artifacts may be read or rendered. Runtime writes to staging paths, validates the canonical artifact, and atomically publishes it at its final path; failed production remains observable without presenting a partial file as valid experimental evidence.
