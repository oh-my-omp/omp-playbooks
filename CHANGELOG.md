# Changelog

## [Unreleased]

### Fixed

- Fixed "Playbook: open" in Tern's command palette on Windows: the plugin passes the document path and the focused pane to the document service, so paths with spaces, quotes and backslashes arrive unchanged
- Fixed the document service and the pane listener failing to start on Windows when the temporary directory's path is long
- Fixed the Playbook pane staying blank on Windows: the document service now reads Tern's replies that Windows ConPTY delivers as OSC 877 messages
- Fixed `playbook_open` and "New session" of the coordinator picker on Windows: the document service and the new omp session now start in their Tern pane with the caller's language. The pane command sets the language through omp's own bash (`omp bash`) on every platform, so it no longer needs the `env` program Windows does not have, and it holds no double quote, which Windows PowerShell 5.1 drops from the arguments of programs it starts
- Fixed opening an already open Playbook again on Windows: the second document service now shows the existing pane instead of failing to start, and the leftovers of a killed document service no longer block every later start. Of two document services started for one Playbook at the same moment, exactly one serves and the other shows its pane, on Windows and on macOS/Linux

## [0.1.50] - 2026-11-12

### Changed

- The plugin now ships on the `release` branch instead of following `main`: every merge to `main` keeps its entry under `## [Unreleased]` here, and one run of the shared omomp release workflow each day at 02:00 GMT+9 promotes those entries into a version, tags it and moves `release` together with `main`. The version in `package.json` and `tern-plugin/plugin.toml` changes only then, still in both files together, so the extension keeps telling old and new code apart; the per-push version bump is gone.
