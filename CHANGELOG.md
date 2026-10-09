# Changelog

All notable changes to `ccusage-sync` are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/)
(while on 0.x, a minor version may break things). Updates to the pinned ccusage are listed too, since they can change
report output.

## [Unreleased]

### Added

- `hosts edit <name> [--ssh <target>] [--path <p>]...` changes a host in place, keeping its mirror.

### Fixed

- Logs mirrored from a path a host no longer has are now read, pruned and slimmed like the rest. Before, changing a
  host's `paths` dropped them from reports without a warning. `hosts list` shows how many such directories each host
  has.
- A host's `paths` are rejected when two of them would be mirrored into one directory, such as `.claude/projects` and
  `.Claude/projects` (one directory on macOS) or `/srv/a-b` and `/srv/a_b`. Before, their logs were merged into it.

## [0.2.0] - 2026-10-08

### Added

- `retention` config field: how long mirrored transcripts are kept, by when they were last modified. `"claude"`
  follows Claude Code's `cleanupPeriodDays` on this machine, a duration such as `"90d"` sets it directly, and
  `"forever"` keeps everything. See [Retention](README.md#retention).
- `store` config field: `"usage"` mirrors only what ccusage reads, about a tenth of the size, with identical reports.
  Syncs then fetch only the bytes added since the last one, over one SSH connection without rsync. The default stays
  `"full"`. See [Store](README.md#store).

### Changed

- **Mirrors are now pruned by default.** The default `retention` is `"claude"` (30 days unless you changed
  `cleanupPeriodDays`), so the first sync after upgrading deletes mirrored transcripts last modified more than a day
  before that window. To keep them, set `"retention": "forever"` before running it.
- A sync now first lists each host's transcripts in one `ssh` call, then fetches only those within the retention
  window.

## [0.1.0] - 2026-10-05

Initial release: mirrors Claude Code logs from configured hosts over SSH with rsync, and runs ccusage 20.0.26 over the
local logs plus all mirrors.

[Unreleased]: https://github.com/Rosenblad/ccusage-sync/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Rosenblad/ccusage-sync/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Rosenblad/ccusage-sync/tree/v0.1.0
