# Changelog

## [Unreleased]

### Changed

- Updated the shared copy of `compact-handoff.ts` to oh-my-omp/shared@69618f3.

## [0.1.57] - 2026-11-27

### Fixed

- The Playbook document service starts again on machines whose omp plugin tree still holds older host packages (for example `@oh-my-pi/pi-coding-agent` 18.2.6): `playbook_open` and Tern's `Playbook: open` no longer fail with `Cannot find module '@oh-my-pi/pi-coding-agent/ui/theme/service'`. The service runs outside omp, so the host packages it imports (`pi-coding-agent`, `pi-natives`, `pi-tui`, `pi-utils`) are now regular dependencies installed at their current version instead of peers satisfied by whatever copy the plugin tree already had.

## [0.1.56] - 2026-11-27

### Fixed

- The extension loads again on omp 19.2.0: `playbook://` tool errors now come from the host's `@oh-my-pi/pi-coding-agent/tools/tool-errors`, and the Playbook pane draws SVG figures and follows the dark/light theme through the host's `ui/transcript/figures/svg` and `ui/theme/service` instead of pi-tui paths removed in 19.2.0.
- `bun.lock` now records the host packages as dev and peer dependencies, matching `package.json`, so `bun install --frozen-lockfile` succeeds again.

## [0.1.55] - 2026-11-24

### Changed

- Updated the shared copy of `compact-handoff.ts` to oh-my-omp/shared@db9dde4.
- Synced `compact-handoff.ts` and `context-delta.ts` from `oh-my-omp/shared@8f2c5e520126`, deferred `playbook-event` launch, pane attach, and service notices across compaction via the shared compaction barrier, and registered `omp-playbooks` (`source="omp-playbooks/active-runs"`) as a stateful post-compaction handoff that re-injects connected Playbook document paths and `playbook://` handles via `delta-stream`.

## [0.1.54] - 2026-11-22

### Changed

- Updated the shared copy of `tern-plugin.ts` to oh-my-omp/shared@a88403a.
- Migrated all `playbook_*` topic pointers from `xd://` to `help://` and updated coordinator notices, errors, topic docs, and READMEs to omp 19.1.0's mounted command form (`playbook_<name> --json '{…}'` / `--help`).

### Fixed

- A Launch of blocks without a shared preset `agent` no longer fails on the coordinator's first call when the session's default subagent is disabled: the `launch_requested` notice now writes `agent: "<subagent>"` into its `playbook.agent` / `playbook.run` calls and names the subagents the session can start, from the same list as the SUBAGENT dropdown. When the session cannot list them, the notice keeps the general hint.

## [0.1.53] - 2026-11-20

### Changed

- `/playbook-add` asks in two HTML forms through omp's `ui.formDialog`: the first shows the session message, the log (the Playbook itself or a Run) and the record kind on one screen, and the second the optional block of the chosen log. The four one-question selects are gone. An omp that cannot show forms reports one error and asks nothing

## [0.1.52] - 2026-11-19

### Changed

- Updated the shared copy of `i18n.ts` to oh-my-omp/shared@33dbe00.

## [0.1.51] - 2026-11-15

### Fixed

- Fixed "Playbook: open" in Tern's command palette on Windows: the plugin passes the document path and the focused pane to the document service, so paths with spaces, quotes and backslashes arrive unchanged
- Fixed the document service and the pane listener failing to start on Windows when the temporary directory's path is long
- Fixed the Playbook pane staying blank on Windows: the document service now reads Tern's replies that Windows ConPTY delivers as OSC 877 messages
- Fixed `playbook_open` and "New session" of the coordinator picker on Windows: the document service and the new omp session now start in their Tern pane with the caller's language. The pane command sets the language through omp's own bash (`omp bash`) on every platform, so it no longer needs the `env` program Windows does not have, and it holds no double quote, which Windows PowerShell 5.1 drops from the arguments of programs it starts
- Fixed opening an already open Playbook again on Windows: the second document service now shows the existing pane instead of failing to start, and the leftovers of a killed document service no longer block every later start. Of two document services started for one Playbook at the same moment, exactly one serves and the other shows its pane, on Windows and on macOS/Linux

## [0.1.50] - 2026-11-12

### Changed

- The plugin now ships on the `release` branch instead of following `main`: every merge to `main` keeps its entry under `## [Unreleased]` here, and one run of the shared omomp release workflow each day at 02:00 GMT+9 promotes those entries into a version, tags it and moves `release` together with `main`. The version in `package.json` and `tern-plugin/plugin.toml` changes only then, still in both files together, so the extension keeps telling old and new code apart; the per-push version bump is gone.
