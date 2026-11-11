# Changelog

## [Unreleased]

### Changed

- The plugin now ships on the `release` branch instead of following `main`: every merge to `main` keeps its entry under `## [Unreleased]` here, and one run of the shared omomp release workflow each day at 02:00 GMT+9 promotes those entries into a version, tags it and moves `release` together with `main`. The version in `package.json` and `tern-plugin/plugin.toml` changes only then, still in both files together, so the extension keeps telling old and new code apart; the per-push version bump is gone.
