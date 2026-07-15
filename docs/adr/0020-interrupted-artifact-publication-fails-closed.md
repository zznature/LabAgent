# Interrupted artifact publication fails closed

If Runtime stops before descriptor and index publication completes, the in-progress artifact becomes `failed` with `publication_interrupted`. Restart recovery preserves or quarantines staging files as diagnostic evidence but never infers canonical success from file presence or apparent completeness. Resume or retry creates a new immutable execution attempt and new artifact identities rather than completing or overwriting the interrupted result.
