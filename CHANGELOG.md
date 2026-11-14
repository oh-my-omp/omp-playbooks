# Changelog

## [Unreleased]

### Fixed

- Fixed `playbook_open` and "New coordinator session" on Windows: the document service and the new omp session now start in their Tern pane with the caller's language, where the pane command used to need the `env` program Windows does not have
- Fixed opening an already open Playbook again on Windows: the second document service now shows the existing pane instead of exiting with `EACCES`, and a socket file left by a killed service no longer blocks every later start. Of two document services started for one Playbook at the same moment, exactly one serves and the other shows its pane, on Windows and on macOS/Linux (where the second used to exit with `EEXIST`)

## [0.1.50] - 2026-11-12

### Changed

- The plugin now ships on the `release` branch instead of following `main`: every merge to `main` keeps its entry under `## [Unreleased]` here, and one run of the shared omomp release workflow each day at 02:00 GMT+9 promotes those entries into a version, tags it and moves `release` together with `main`. The version in `package.json` and `tern-plugin/plugin.toml` changes only then, still in both files together, so the extension keeps telling old and new code apart; the per-push version bump is gone.
