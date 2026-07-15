# Artifacts have profile-defined representations

A logical canonical artifact has one descriptor and may contain multiple representations with profile-defined roles, such as `data`, `display`, `thumbnail`, or `download`. Frontends treat the descriptor as one experimental result rather than grouping files heuristically. Every representation declares its media type, path, size, and integrity metadata, and profiles reject arbitrary role names.
