import { spawn as nodeSpawn } from 'node:child_process'
import { join } from 'node:path'
import type { CcusageCommand } from './ccusage.js'
import { LOCAL } from './argv.js'
import { type Config, type HostConfig, hostPaths, isLocalHost } from './config.js'
import { type Env, hasProjects, hostDir, hostSlots } from './paths.js'
import { type SignalSource, signalExitCode, trapSignals } from './signals.js'
import { knownSlots } from './sync.js'

export interface Selection {
  includeLocal: boolean
  /** Remote hosts to sync and read mirrors from. */
  hosts: HostConfig[]
  /** Selected hosts that are this machine: read locally instead. */
  skipped: HostConfig[]
  /** The source names asked for, for error messages. */
  names: string[]
}

/** Applies `--hosts` (default: everything). A host that is this machine counts as `local`. */
export function selectSources(config: Config, hostsFlag: string[] | undefined, localHostname: string): Selection {
  const names = hostsFlag ?? [LOCAL, ...config.hosts.map((host) => host.name)]
  const chosen = config.hosts.filter((host) => names.includes(host.name))
  const skipped = chosen.filter((host) => isLocalHost(host, localHostname))
  return {
    includeLocal: names.includes(LOCAL) || skipped.length > 0,
    hosts: chosen.filter((host) => !skipped.includes(host)),
    skipped,
    names,
  }
}

/** Each host's slots, including ones left over from paths it no longer has. */
export function mirrorRoots(dataDir: string, hosts: HostConfig[]): string[] {
  return hosts.flatMap((host) => {
    const dir = hostDir(dataDir, host.name)
    return hostSlots(dir, knownSlots(dir), hostPaths(host)).map((slot) => join(dir, slot))
  })
}

/** Local roots first, then mirrors. Only roots ccusage would accept (containing `projects/`) are kept. */
export function buildRoots(
  local: string[],
  mirrors: string[],
  exists: (root: string) => boolean = hasProjects,
): string[] {
  const roots = [...new Set([...local, ...mirrors])].filter(exists)
  const withComma = roots.find((root) => root.includes(','))
  if (withComma) throw new Error(`cannot pass '${withComma}' to ccusage: CLAUDE_CONFIG_DIR is comma-separated`)
  return roots
}

export interface SpawnDeps {
  spawn?: typeof nodeSpawn
  signals?: SignalSource
  stderr?: (text: string) => void
}

/** Runs ccusage with stdio inherited and forwarded signals. Resolves to its exit code (128+n if killed by signal n). */
export function runCcusage(cmd: CcusageCommand, args: string[], env: Env, deps: SpawnDeps = {}): Promise<number> {
  const spawn = deps.spawn ?? nodeSpawn
  const stderr = deps.stderr ?? ((text) => process.stderr.write(text))
  return new Promise((resolve) => {
    const child = spawn(cmd.command, [...cmd.args, ...args], { stdio: 'inherit', env })
    const untrap = trapSignals((signal) => {
      child.kill(signal)
    }, deps.signals)
    child.on('error', (error) => {
      untrap()
      stderr(`ccusage-sync: failed to run ccusage: ${error.message}\n`)
      resolve(1)
    })
    child.on('exit', (code, signal) => {
      untrap()
      resolve(signal ? signalExitCode(signal) : (code ?? 1))
    })
  })
}
