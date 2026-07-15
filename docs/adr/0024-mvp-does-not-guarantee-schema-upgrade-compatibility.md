# MVP does not guarantee schema upgrade compatibility

The MVP keeps explicit schema versions in observation and artifact contracts but does not implement historical-version readers, migrations, or cross-upgrade compatibility guarantees. The immediate objective is to validate the live experiment and frontend observation loop. Formal artifacts remain immutable within the current version; upgrade compatibility will be designed only after the MVP contract has been exercised in real experiments.
