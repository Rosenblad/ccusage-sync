import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import pc from 'picocolors'
import { UsageError } from './argv.js'
import {
  clashMessage,
  type Config,
  type HostConfig,
  hostPaths,
  isLocalHost,
  loadConfig,
  normalizeRemotePath,
  saveConfig,
  slotClash,
  validateHostName,
} from './config.js'
import { hostDir, leftoverSlots } from './paths.js'
import { formatAgo, knownSlots, readState, type Runner, shellQuote } from './sync.js'

export interface HostsDeps {
  configFile: string
  dataDir: string
  run: Runner
  now: () => Date
  hostname: string
  stdout: (text: string) => void
  stderr: (text: string) => void
  /** Asks a yes/no question; undefined when stdin is not a TTY. */
  confirm: ((question: string) => Promise<boolean>) | undefined
}

export const HOSTS_USAGE = `Usage:
  ccusage-sync hosts add <name> <ssh-target> [--path <remote-path>]... [--no-verify]
  ccusage-sync hosts edit <name> [--ssh <ssh-target>] [--path <remote-path>]... [--no-verify]
  ccusage-sync hosts remove <name> [--purge]
  ccusage-sync hosts list
`

export async function hostsCommand(args: string[], deps: HostsDeps): Promise<number> {
  const [sub, ...rest] = args
  switch (sub) {
    case 'add':
      return addHost(rest, deps)
    case 'edit':
      return editHost(rest, deps)
    case 'remove':
    case 'rm':
      return removeHost(rest, deps)
    case 'list':
    case 'ls':
      return listHosts(rest, deps)
    case '--help':
    case '-h':
      deps.stdout(HOSTS_USAGE)
      return 0
    case undefined:
      deps.stderr(HOSTS_USAGE)
      return 1
    default:
      throw new UsageError(`Unknown hosts command '${sub}'.\n${HOSTS_USAGE}`)
  }
}

/** Splits flags from positionals. `valueFlags` take a value (`--x v` or `--x=v`) and may repeat. */
function parseFlags(args: string[], boolFlags: string[], valueFlags: string[]) {
  const positionals: string[] = []
  const bools = new Set<string>()
  const values = new Map<string, string[]>()
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    const eq = arg.indexOf('=')
    const flag = arg.startsWith('--') && eq > 0 ? arg.slice(0, eq) : arg
    if (valueFlags.includes(flag)) {
      const value = flag === arg ? args[++i] : arg.slice(eq + 1)
      if (value === undefined) throw new UsageError(`${flag} expects a value`)
      values.set(flag, [...(values.get(flag) ?? []), value])
    } else if (boolFlags.includes(arg)) {
      bools.add(arg)
    } else if (arg.startsWith('-')) {
      throw new UsageError(`Unknown option '${arg}'.\n${HOSTS_USAGE}`)
    } else {
      positionals.push(arg)
    }
  }
  return { positionals, bools, values }
}

async function addHost(args: string[], deps: HostsDeps): Promise<number> {
  const { positionals, bools, values } = parseFlags(args, ['--no-verify'], ['--path'])
  if (positionals.length !== 2) throw new UsageError(`hosts add expects <name> <ssh-target>.\n${HOSTS_USAGE}`)
  const [name, ssh] = positionals as [string, string]
  validateHostName(name)
  checkSsh(ssh)

  const config = loadConfig(deps.configFile)
  if (config.hosts.some((host) => host.name === name)) {
    throw new UsageError(`Host '${name}' already exists. Change it with: ccusage-sync hosts edit ${name}`)
  }

  const host: HostConfig = { name, ssh }
  const paths = values.get('--path')
  if (paths) host.paths = parsePaths(paths)

  if (!(await saveHost(config, host, !bools.has('--no-verify'), deps))) return 1
  deps.stdout(`Added ${name} (${ssh}). Run \`ccusage-sync sync\` to fetch its logs.\n`)
  noteIfLocal(host, deps)
  return 0
}

/** Replaces the given fields in place. The mirror is kept, including slots for paths the host no longer has. */
async function editHost(args: string[], deps: HostsDeps): Promise<number> {
  const { positionals, bools, values } = parseFlags(args, ['--no-verify'], ['--ssh', '--path'])
  if (positionals.length !== 1) throw new UsageError(`hosts edit expects <name>.\n${HOSTS_USAGE}`)
  const name = positionals[0]!
  validateHostName(name)
  const ssh = values.get('--ssh')
  const paths = values.get('--path')
  if (!ssh && !paths) throw new UsageError(`hosts edit expects --ssh or --path.\n${HOSTS_USAGE}`)
  if (ssh && ssh.length > 1) throw new UsageError('--ssh may only be given once')

  const config = loadConfig(deps.configFile)
  const existing = config.hosts.find((host) => host.name === name)
  if (!existing) throw unknownHost(name, config)
  const host: HostConfig = { ...existing }
  if (ssh) host.ssh = checkSsh(ssh[0]!)
  if (paths) host.paths = parsePaths(paths)

  if (!(await saveHost(config, host, !bools.has('--no-verify'), deps))) return 1
  deps.stdout(`Updated ${name} (${host.ssh}, ${hostPaths(host).join(', ')}).\n`)
  const dir = hostDir(deps.dataDir, name)
  const leftover = leftoverSlots(dir, knownSlots(dir), hostPaths(host))
  if (leftover.length > 0) {
    // Reports here leave this machine's mirror out (see selectSources), so only claim they read it for another host.
    const read = isLocalHost(host, deps.hostname) ? '' : ' and still included in reports'
    deps.stdout(`Logs mirrored from paths it no longer has are kept${read}: ${leftover.map((slot) => join(dir, slot)).join(', ')}\n`)
  }
  noteIfLocal(host, deps)
  return 0
}

/** Verifies `host` unless told not to, then saves it to `config` in place of any host of its name. False if unverified. */
async function saveHost(config: Config, host: HostConfig, verify: boolean, deps: HostsDeps): Promise<boolean> {
  if (verify && !(await verifyHost(host, deps))) return false
  const i = config.hosts.findIndex((other) => other.name === host.name)
  if (i === -1) config.hosts.push(host)
  else config.hosts[i] = host
  saveConfig(deps.configFile, config)
  return true
}

function noteIfLocal(host: HostConfig, deps: HostsDeps): void {
  if (isLocalHost(host, deps.hostname)) {
    deps.stderr(`Note: ${host.name} looks like this machine, so it is skipped here (its logs are read locally).\n`)
  }
}

function unknownHost(name: string, config: Config): UsageError {
  return new UsageError(`Unknown host '${name}'. Configured: ${config.hosts.map((host) => host.name).join(', ') || '(none)'}`)
}

function checkSsh(ssh: string): string {
  if (ssh.trim() === '') throw new UsageError('ssh target must not be empty')
  return ssh
}

/** `--path` values, normalized and deduplicated. */
function parsePaths(values: string[]): string[] {
  const paths = values.map(normalizeRemotePath)
  if (paths.some((path) => path === '')) throw new UsageError('--path must not be empty')
  const clash = slotClash(paths)
  if (clash) throw new UsageError(`--path: ${clashMessage(clash)}`)
  return [...new Set(paths)]
}

/** Fails if the host is unreachable; warns (but succeeds) if none of the paths exist there. */
async function verifyHost(host: HostConfig, deps: HostsDeps): Promise<boolean> {
  const paths = hostPaths(host)
  const result = await deps.run('ssh', [
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=10',
    host.ssh,
    `ls -d ${paths.map(shellQuote).join(' ')}`,
  ])
  if (result.error) {
    deps.stderr(`ccusage-sync: cannot run ssh: ${result.error.message}\n`)
    return false
  }
  if (result.code === 255) {
    const why = /Permission denied/.test(result.stderr) ? 'SSH auth failed (key-based auth required, BatchMode)' : 'cannot reach host'
    deps.stderr(`ccusage-sync: ${why}: ${host.ssh}\n${result.stderr.trim()}\nFix SSH access, or add it anyway with --no-verify.\n`)
    return false
  }
  const found = result.stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '')
  if (found.length === 0) {
    deps.stderr(
      `${pc.yellow('Warning:')} none of these paths exist on ${host.ssh}: ${paths.join(', ')}\n` +
        `Saving anyway. If Claude Code keeps its logs elsewhere there, point at them with: ` +
        `ccusage-sync hosts edit ${host.name} --path <dir>/projects\n`,
    )
  }
  return true
}

async function removeHost(args: string[], deps: HostsDeps): Promise<number> {
  const { positionals, bools } = parseFlags(args, ['--purge'], [])
  if (positionals.length !== 1) throw new UsageError(`hosts remove expects <name>.\n${HOSTS_USAGE}`)
  const name = positionals[0]!
  // The name becomes a path that may be deleted: `..` or `../x` must never reach hostDir.
  validateHostName(name)
  const config = loadConfig(deps.configFile)
  const mirror = hostDir(deps.dataDir, name)
  const configured = config.hosts.some((host) => host.name === name)

  // An unconfigured name is still accepted if its mirror is left over, so `--purge` can be rerun.
  if (!configured && !existsSync(mirror)) throw unknownHost(name, config)
  if (configured) {
    config.hosts = config.hosts.filter((host) => host.name !== name)
    saveConfig(deps.configFile, config)
    deps.stdout(`Removed ${name}.\n`)
  }
  if (!existsSync(mirror)) return 0
  // Never synced (e.g. only a failed attempt's state.json): nothing worth keeping, so no question.
  if (!hasLogs(mirror)) {
    rmSync(mirror, { recursive: true, force: true })
    return 0
  }

  let purge = bools.has('--purge')
  if (!purge && deps.confirm) purge = await deps.confirm(`Delete mirrored logs at ${mirror}? [y/N] `)
  if (purge) {
    rmSync(mirror, { recursive: true, force: true })
    deps.stdout(`Deleted ${mirror}.\n`)
  } else {
    deps.stdout(`Kept mirrored logs at ${mirror}. To delete them: ccusage-sync hosts remove ${name} --purge\n`)
  }
  return 0
}

function hasLogs(dir: string): boolean {
  try {
    return readdirSync(dir, { recursive: true }).some((path) => String(path).endsWith('.jsonl'))
  } catch {
    return false
  }
}

function listHosts(args: string[], deps: HostsDeps): number {
  if (args.length > 0) throw new UsageError(`hosts list takes no arguments.\n${HOSTS_USAGE}`)
  const config = loadConfig(deps.configFile)
  if (config.hosts.length === 0) {
    deps.stdout('No hosts configured. Add one with: ccusage-sync hosts add <name> <ssh-target>\n')
    return 0
  }
  const now = deps.now()
  const ago = (iso: string | null) => (iso ? formatAgo(now.getTime() - Date.parse(iso)) : 'never')
  const rows = config.hosts.map((host) => {
    const dir = hostDir(deps.dataDir, host.name)
    const state = readState(dir)
    let status: string
    if (isLocalHost(host, deps.hostname)) status = pc.dim('this machine, skipped')
    else if (state.lastError) status = pc.red(`${state.lastError} (${ago(state.lastAttempt)})`)
    else if (state.lastSuccess) status = pc.green('ok')
    else status = pc.dim('not synced yet')
    const leftover = leftoverSlots(dir, knownSlots(dir, state), hostPaths(host)).length
    const paths = `${hostPaths(host).join(', ')}${leftover > 0 ? ` (+${leftover} old)` : ''}`
    return [host.name, host.ssh, paths, ago(state.lastSuccess), status]
  })
  const header = ['NAME', 'SSH', 'PATHS', 'LAST SYNC', 'STATUS']
  const widths = header.map((title, i) => Math.max(title.length, ...rows.map((row) => row[i]!.length)))
  const line = (cells: string[]) =>
    cells.map((cell, i) => (i === cells.length - 1 ? cell : cell.padEnd(widths[i]!))).join('  ')
  deps.stdout(`${pc.bold(line(header))}\n${rows.map(line).join('\n')}\n`)
  return 0
}
