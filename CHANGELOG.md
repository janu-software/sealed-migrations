# Changelog

## 0.1.0

Initial release.

- Checksum-tracked SQL migration runner for MySQL / MariaDB with a dev-first
  lifecycle: migrations start unnumbered as `dev_<slug>/` and are sealed to
  `NNN_<slug>/` right before merge, so parallel branches never collide on numbers.
- `createRunner(config)` with `up`, `down`, `seal`, `rehash`, `current`, `status`
  and a `runCli(argv)` helper.
- Connection injection: the SQL driver is supplied by the consumer, so the
  package has no runtime dependencies.
- Config hooks for `assertServer` (e.g. a MariaDB check) and `withRetry`
  (e.g. a cluster deadlock retry).
- Parallel-branch tolerance (foreign dev rows warn, numbered rows stay strict),
  the SQL-first / DB-first iteration loops, and the `--allow-dev` production guard.
