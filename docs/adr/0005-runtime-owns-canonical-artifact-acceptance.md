# Runtime owns canonical artifact acceptance

The Runtime is accountable for producing or coordinating conversion of canonical artifacts, validating their versioned schemas, archiving their files, and registering their descriptors. Drivers produce source artifacts and may provide device-specific conversion code; the Kernel supplies run, unit, and attempt identity; frontends only consume accepted canonical artifacts. A canonical artifact is not complete until the Runtime has validated and atomically archived it.
