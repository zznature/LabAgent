# Canonical Raman spectra use JSON and CSV

The `raman-spectrum` profile provides a versioned JSON `data` representation for the Run Observation Contract and a UTF-8 CSV `download` representation for external analysis. JSON carries explicit axis kinds, units, values, acquisition context, and derived metrics; CSV uses profile-defined unit-bearing headers. Spectrum plots are frontend views or reproducible caches, not authoritative canonical results.
