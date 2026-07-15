# Canonical spectra require explicit scientific axes

A `raman-spectrum` canonical artifact is valid only when every scientific axis has an explicit kind and unit. Runtime must not infer Raman shift, wavelength, pixel index, intensity units, or other scientific meaning from column position alone. If source output lacks sufficient axis semantics, the source artifact remains preserved and the canonical artifact becomes `failed` with an observable normalization error.
