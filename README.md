# ccusage-sync

[ccusage](https://github.com/ccusage/ccusage), across all your machines.

**Unofficial:** `ccusage-sync` is an independent tool. It is not affiliated with or endorsed by ccusage or its
maintainers.

`ccusage-sync` mirrors Claude Code logs from every machine you configure to the one you run it on (over SSH, with
`rsync`), then runs ccusage over the local logs plus all mirrors. Every ccusage report (`daily`, `weekly`, `monthly`,
`session`, `blocks`, `statusline`, `--json`, …) then shows your usage **summed across machines**.

- It adds no reports of its own and has no per-machine view. If you want one machine's numbers, use `--hosts`.
- Only Claude Code logs are mirrored for now. See [Limitations](#limitations).
- Without any hosts configured, it behaves exactly like plain `ccusage`.

## Requirements

- macOS or Linux (on this machine and on the hosts)
- Node.js 22 or later
- `rsync` on both ends (macOS's built-in `rsync` works)
- Key-based SSH access to each host. Syncs run with `BatchMode=yes`, so password prompts are not possible. Your
  `~/.ssh/config`, keys and agent are used as-is.

## Install

```sh
npm install -g ccusage-sync
```

Or run it without installing: `npx ccusage-sync claude daily`.

ccusage itself is a pinned dependency and is installed with it; you don't need it installed separately.

## Quick start

```sh
ccusage-sync hosts add workstation me@workstation.local
ccusage-sync hosts add laptop laptop          # an alias from ~/.ssh/config works too
ccusage-sync claude daily
```

`hosts add` checks that the host is reachable before saving it, and warns if it finds no Claude Code logs there.

## Usage

Every ccusage command and option works; anything that isn't ours is passed to ccusage unchanged:

```sh
ccusage-sync                         # same as `ccusage` (daily)
ccusage-sync claude daily --breakdown
ccusage-sync claude blocks --active
ccusage-sync claude monthly --json
```

Before a report, hosts that haven't been tried within `syncMaxAge` (default 5 minutes) are synced. A host that can't be
reached doesn't stop the report: you get a one-line warning on stderr and the report uses that host's last mirror.

Prefer `ccusage-sync claude …` over the unified commands (`ccusage-sync daily`). The unified commands also include
Codex, OpenCode and other agents, but only from this machine, because only Claude Code logs are mirrored.

### Options

These are ours, valid with any ccusage command and with `sync`:

| Option | Meaning |
|---|---|
| `--no-sync` | Don't contact any host; use the existing mirrors. |
| `--hosts a,b` | Only include these sources. `local` means this machine. E.g. `--hosts laptop` shows only the laptop's usage. |
| `--` | Pass everything after it to ccusage untouched (in case a ccusage option value is literally `--no-sync` or `--hosts`). |

`--help` and `--version` are ours only as the first argument; `ccusage-sync claude daily --help` shows ccusage's help.

### Commands

```sh
ccusage-sync hosts add <name> <ssh-target> [--path <remote-path>]... [--no-verify]
ccusage-sync hosts remove <name> [--purge]
ccusage-sync hosts list               # ssh target, paths, last sync, last error
ccusage-sync sync [--hosts a,b]       # sync now, regardless of syncMaxAge
```

- **`hosts add`** takes a short name (lowercase letters, digits, dashes) and anything `ssh` accepts as a target. By
  default it mirrors `~/.claude/projects` and `~/.config/claude/projects`, the two places ccusage looks. If a host
  keeps its logs elsewhere (for example it sets `CLAUDE_CONFIG_DIR`), pass `--path <dir>/projects` once per location.
  `--no-verify` saves the host without connecting to it.
- **`hosts remove`** removes the host and asks whether to delete its mirrored logs. Without a terminal it keeps them;
  `--purge` deletes them without asking.

### As the Claude Code statusline

```json
{
  "statusLine": { "type": "command", "command": "ccusage-sync statusline" }
}
```

The statusline **never syncs**, so it stays fast. Its cross-machine numbers are only as fresh as the last report or
`ccusage-sync sync` you ran.

### Using one config on every machine

You can copy the same `config.json` to every machine. A host whose name or SSH host name matches the machine you're
on is skipped there (its logs are read locally instead). Matching ignores `user@`, `:port` and the domain, and is
case-insensitive. SSH aliases are not resolved, so if you rely on that, name the host after the machine's hostname.

## Configuration

`~/.config/ccusage-sync/config.json` (or `$XDG_CONFIG_HOME/ccusage-sync/config.json`), created by the first
`hosts add`:

```json
{
  "version": 1,
  "syncMaxAge": "5m",
  "retention": "claude",
  "hosts": [
    { "name": "workstation", "ssh": "me@workstation.local" },
    { "name": "laptop", "ssh": "laptop", "paths": [".claude/projects"] }
  ]
}
```

| Field | Meaning |
|---|---|
| `version` | Always `1`. |
| `syncMaxAge` | How long after a sync attempt reports skip contacting a host again: a number followed by `s`, `m`, `h` or `d`. Default `5m`. |
| `retention` | How long mirrored transcripts are kept, by when they were last modified: `"claude"`, a duration such as `"90d"`, or `"forever"`. Default `"claude"`. See [Retention](#retention). |
| `hosts[].name` | Short name used in `--hosts` and for the mirror directory. `local` is reserved. |
| `hosts[].ssh` | SSH target, passed to `ssh` as-is. |
| `hosts[].paths` | Optional. Claude Code `projects` directories on the host, relative to its home directory (or absolute). Default `[".claude/projects", ".config/claude/projects"]`. |

### Where mirrors live

`~/.local/share/ccusage-sync/hosts/<name>/` (or `$XDG_DATA_HOME/ccusage-sync/…`), one subdirectory per remote path,
plus `state.json` with the last sync attempt, success and error.

Only `*.jsonl` files are copied, and syncs are incremental. Files the host deletes are not deleted from the mirror;
only [retention](#retention) removes them.

### Retention

Mirrors would otherwise grow without limit: transcripts hold the whole conversation, often tens of MB per day of use.
So mirrored transcripts are kept only as long as `retention` says:

- **`"claude"`** (default): as long as Claude Code keeps transcripts on this machine, its
  [`cleanupPeriodDays`](https://code.claude.com/docs/en/settings-reference#cleanupperioddays) (30 days unless you
  changed it). It is read from your managed settings file, the cached server-managed settings, or your user
  `settings.json` (in `$CLAUDE_CONFIG_DIR` if set), whichever sets it first. Like Claude Code, it keeps everything if
  one of those can't be read or parsed, or sets an invalid value. MDM profiles are not read; if your organization
  sets the period that way, set `retention` to the same duration.
- **A duration** such as `"90d"`: a number followed by `s`, `m`, `h` or `d`.
- **`"forever"`**: never delete, keeping history beyond what the hosts keep. Mirrors then grow without limit.

A sync fetches only transcripts the host modified within the window, then deletes mirrored ones last modified more
than a day before the window began. The extra day keeps a clock difference between the machines from deleting a
file that the next sync would fetch again. Deleting happens on every sync, also when the host can't be reached, and
never in `--no-sync` runs or the statusline.

Reports cover what is kept: with the default, that is the last 30 days or so from every machine, the same as your
local logs. To report on longer periods, raise `retention` (and `cleanupPeriodDays` for local logs).

## Uninstall

```sh
npm uninstall -g ccusage-sync
rm -rf ~/.config/ccusage-sync ~/.local/share/ccusage-sync
```

## Limitations

- **Claude Code only.** The unified commands (`ccusage-sync daily` etc.) include other agents from this machine only.
- **No per-machine view.** Reports are summed; use `--hosts <name>` to look at one machine.
- **Statusline freshness.** The statusline uses whatever was last synced.
- **No background sync** yet.
- **No Windows support.** Only macOS and Linux, on this machine and on the hosts.

## Development

```sh
git clone https://github.com/Rosenblad/ccusage-sync.git
cd ccusage-sync
npm install         # also builds dist/
npm test            # unit tests + ccusage contract tests
npm run typecheck
npm run build
npm install -g .    # install your local build as `ccusage-sync`
```

The contract tests (`test/contract.test.ts`) run the pinned ccusage binary on synthetic fixtures. They check the ccusage
behaviour this tool relies on (merging several roots in `CLAUDE_CONFIG_DIR`, dedup across roots, skipping missing
roots, and our flags not clashing with ccusage's). Run them whenever the ccusage version is bumped.

## License

MIT. See [LICENSE](LICENSE).
