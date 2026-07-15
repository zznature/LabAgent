# Canonical Raman frames use PNG and WebP

The `raman-frame` profile provides a full-resolution lossless PNG `display` representation and a bounded-size WebP `thumbnail` representation. The instrument TIFF remains an immutable source artifact. The descriptor records image dimensions, source bit depth, color model, capture time, provenance, and verified laser state. A requested laser state is not evidence of instrument state; absent verification, `laserState` is `unknown` rather than inferred as `off`.
