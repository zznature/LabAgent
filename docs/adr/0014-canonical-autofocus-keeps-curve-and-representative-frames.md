# Canonical autofocus keeps curve and representative frames

The `raman-autofocus` profile has one versioned JSON `data` representation containing scan points, peak estimate, selected focus and selection source, final verification, confidence diagnostics, parameters, and algorithm version. It references separate canonical `raman-frame` artifacts for the pre-focus and accepted-focus images. Intermediate Z-sample frames remain source or diagnostic artifacts so the frontend result surface is not flooded with internal sampling evidence.
