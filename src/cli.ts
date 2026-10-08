#!/usr/bin/env node
import { type ChildProcess, spawnSync } from 'node:child_process'
import { hostname } from 'node:os'
import { createInterface } from 'node:readline/promises'
import pc from 'picocolors'
import pkg from '../package.json' with { type: 'json' }
import { parseArgv, UsageError, validateHostNames } from './argv.js'
import { CCUSAGE_MISSING, type CcusageCommand, ccusageVersion, resolveCcusage } from './ccusage.js'
import { type HostConfig, loadConfig, parseDuration } from './config.js'
import { buildRoots, mirrorRoots, runCcusage, selectSources } from './forward.js'
import { HOSTS_USAGE, hostsCommand } from './hosts.js'
import { configFile, dataDir, defaultPathContext, localRoots } from './paths.js'
import { retentionMs } from './retention.js'
import { signalExitCode, trapSignals } from './signals.js'
import { createRunner, formatOutcome, shouldSyncBeforeForward, staleHosts, syncHosts } from './sync.js'

const HELP = `ccusage-sync ${pkg.version}: ccusage over Claude Code logs from all your machines

Usage:
  ccusage-sync [ccusage command and options]   run ccusage over local logs plus all mirrors
  ccusage-sync sync [--hosts a,b]              sync now, regardless of syncMaxAge
${HOSTS_USAGE.replace(/^Usage:\n/, '')}
Options (valid with any ccusage command and with sync):
  --no-sync     don't contact hosts, use existing mirrors
  --hosts a,b   restrict to these sources; "local" is this machine
  --            pass everything after it to ccusage unchanged

Config: ${configFile(defaultPathContext())}

All other arguments are passed to ccusage:

`

/** Syncs hosts, printing a line per host on stderr. Returns the signal if one interrupted it. */
async function sync(
  hosts: HostConfig[],
  skipped: HostConfig[],
  data: string,
  retention: number | undefined,
): Promise<{ failed: boolean; signal?: NodeJS.Signals }> {
  const tty = Boolean(process.stderr.isTTY)
  const now = new Date()
  const nameWidth = Math.max(...[...hosts, ...skipped].map((host) => host.name.length))
  if (tty) {
    for (const host of skipped) {
      process.stderr.write(`${pc.dim('·')} ${host.name.padEnd(nameWidth)}  ${pc.dim('this machine, skipped')}\n`)
    }
  }

  const children = new Set<ChildProcess>()
  let signal: NodeJS.Signals | undefined
  const untrap = trapSignals((received) => {
    signal ??= received
    for (const child of children) child.kill(received)
  })
  try {
    const outcomes = await syncHosts(
      hosts,
      {
        dataDir: data,
        run: createRunner(children),
        now: () => new Date(),
        retentionMs: retention,
        interrupted: () => signal !== undefined,
      },
      (outcome) => {
        const line = formatOutcome(outcome, { tty, now, nameWidth })
        if (line) process.stderr.write(`${line}\n`)
      },
    )
    return { failed: outcomes.some((outcome) => outcome.status === 'failed'), signal }
  } finally {
    untrap()
  }
}

function requireCcusage(): CcusageCommand {
  const cmd = resolveCcusage()
  if (!cmd) throw new UsageError(CCUSAGE_MISSING)
  return cmd
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim())
  } finally {
    rl.close()
  }
}

async function main(argv: string[]): Promise<number> {
  const ctx = defaultPathContext()
  const parsed = parseArgv(argv)

  switch (parsed.kind) {
    case 'help': {
      process.stdout.write(HELP)
      const cmd = requireCcusage()
      // Captured, not inherited: with `--help | head -1`, ccusage would panic writing into the closed pipe.
      const ccusageHelp = spawnSync(cmd.command, [...cmd.args, '--help'], {
        stdio: ['ignore', 'pipe', 'inherit'],
        encoding: 'utf8',
      })
      process.stdout.write(ccusageHelp.stdout ?? '')
      return ccusageHelp.status ?? 1
    }
    case 'version':
      process.stdout.write(`ccusage-sync ${pkg.version} (ccusage ${ccusageVersion() ?? 'not found'})\n`)
      return 0
    case 'hosts':
      return hostsCommand(parsed.args, {
        configFile: configFile(ctx),
        dataDir: dataDir(ctx),
        run: createRunner(),
        now: () => new Date(),
        hostname: hostname(),
        stdout: (text) => process.stdout.write(text),
        stderr: (text) => process.stderr.write(text),
        confirm: process.stdin.isTTY ? confirm : undefined,
      })
    case 'sync': {
      if (parsed.args.length > 0) throw new UsageError(`sync takes no arguments besides --hosts, got: ${parsed.args.join(' ')}`)
      if (parsed.noSync) throw new UsageError('--no-sync cannot be used with sync')
      const config = loadConfig(configFile(ctx))
      if (parsed.hosts) validateHostNames(parsed.hosts, config.hosts.map((host) => host.name))
      const selection = selectSources(config, parsed.hosts, hostname())
      if (selection.hosts.length === 0) {
        process.stderr.write(
          config.hosts.length === 0
            ? 'No hosts configured. Add one with: ccusage-sync hosts add <name> <ssh-target>\n'
            : 'Nothing to sync: no remote hosts selected.\n',
        )
        return config.hosts.length === 0 ? 1 : 0
      }
      const result = await sync(selection.hosts, selection.skipped, dataDir(ctx), retentionMs(config.retention, ctx))
      if (result.signal) return signalExitCode(result.signal)
      return result.failed ? 1 : 0
    }
    case 'forward': {
      const config = loadConfig(configFile(ctx))
      if (parsed.hosts) validateHostNames(parsed.hosts, config.hosts.map((host) => host.name))
      const cmd = requireCcusage()
      // No hosts: behave exactly like plain ccusage, environment untouched.
      if (config.hosts.length === 0) return runCcusage(cmd, parsed.args, process.env)

      const data = dataDir(ctx)
      const selection = selectSources(config, parsed.hosts, hostname())
      if (shouldSyncBeforeForward(parsed.args, parsed.noSync)) {
        const stale = staleHosts(selection.hosts, data, parseDuration(config.syncMaxAge), new Date())
        if (stale.length > 0) {
          const result = await sync(stale, selection.skipped, data, retentionMs(config.retention, ctx))
          if (result.signal) return signalExitCode(result.signal)
        }
      }

      const roots = buildRoots(selection.includeLocal ? localRoots(ctx) : [], mirrorRoots(data, selection.hosts))
      if (roots.length === 0) {
        throw new UsageError(
          `No Claude Code logs found for: ${selection.names.join(', ')}. Run \`ccusage-sync sync\` or check --hosts.`,
        )
      }
      return runCcusage(cmd, parsed.args, { ...process.env, CLAUDE_CONFIG_DIR: roots.join(',') })
    }
  }
}

// The reader went away (`ccusage-sync --help | head -1`): drop the rest of our output instead of crashing.
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code !== 'EPIPE') throw error
})

try {
  process.exitCode = await main(process.argv.slice(2))
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`ccusage-sync: ${message}\n`)
  process.exitCode = 1
}
