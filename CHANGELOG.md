# Changelog

## [Unreleased]

### Fixed

- Fixed opening an already open Playbook again on Windows: the second document service now shows the existing pane instead of exiting with `EACCES`, and a socket file left by a killed service no longer blocks every later start

## [0.1.50] - 2026-11-12

### Changed

- The plugin now ships on the `release` branch instead of following `main`: every merge to `main` keeps its entry under `## [Unreleased]` here, and one run of the shared omomp release workflow each day at 02:00 GMT+9 promotes those entries into a version, tags it and moves `release` together with `main`. The version in `package.json` and `tern-plugin/plugin.toml` changes only then, still in both files together, so the extension keeps telling old and new code apart; the per-push version bump is gone.
