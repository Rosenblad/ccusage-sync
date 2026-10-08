import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { LOCAL } from './argv.js'

export interface HostConfig {
  name: string
  ssh: string
  paths?: string[]
}

/** `full` mirrors transcripts whole; `usage` keeps only what ccusage reads. */
export type Store = 'full' | 'usage'

export interface Config {
  version: 1
  syncMaxAge: string
  /** `claude` (follow Claude Code's cleanupPeriodDays), `forever`, or a duration. */
  retention: string
  store: Store
  hosts: HostConfig[]
}

/** ccusage's two default roots, relative to the remote home. */
export const DEFAULT_PATHS = ['.claude/projects', '.config/claude/projects']
export const DEFAULT_SYNC_MAX_AGE = '5m'
export const DEFAULT_RETENTION = 'claude'
export const DEFAULT_STORE: Store = 'full'

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/
const DURATION_RE = /^(\d+)([smhd])$/

export class ConfigError extends Error {}

export function emptyConfig(): Config {
  return { version: 1, syncMaxAge: DEFAULT_SYNC_MAX_AGE, retention: DEFAULT_RETENTION, store: DEFAULT_STORE, hosts: [] }
}

export function hostPaths(host: HostConfig): string[] {
  return host.paths ?? DEFAULT_PATHS
}

/** `~/x` and `~` are relative to the remote home, which is where rsync and ssh start anyway. */
export function normalizeRemotePath(path: string): string {
  const trimmed = path.trim()
  if (trimmed === '~') return '.'
  return trimmed.startsWith('~/') ? trimmed.slice(2) : trimmed
}

export function parseDuration(value: string): number {
  const match = DURATION_RE.exec(value)
  if (!match) throw new ConfigError(`invalid duration '${value}' (expected e.g. 30s, 5m, 1h, 1d)`)
  const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as 's' | 'm' | 'h' | 'd']
  return Number(match[1]) * unit
}

export function validateHostName(name: string, field = 'name'): void {
  if (!NAME_RE.test(name)) throw new ConfigError(`${field}: '${name}' must match ${NAME_RE.source} (lowercase letters, digits, dashes)`)
  if (name === LOCAL) throw new ConfigError(`${field}: '${LOCAL}' is reserved for this machine`)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function rejectUnknownKeys(obj: Record<string, unknown>, allowed: string[], where: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) throw new ConfigError(`${where}${key}: unknown field`)
  }
}

export function validateConfig(raw: unknown): Config {
  if (!isObject(raw)) throw new ConfigError('config must be a JSON object')
  rejectUnknownKeys(raw, ['version', 'syncMaxAge', 'retention', 'store', 'hosts'], '')
  if (raw.version !== 1) throw new ConfigError(`version: must be 1, got ${JSON.stringify(raw.version)}`)

  const syncMaxAge = raw.syncMaxAge ?? DEFAULT_SYNC_MAX_AGE
  if (typeof syncMaxAge !== 'string' || !DURATION_RE.test(syncMaxAge)) {
    throw new ConfigError(`syncMaxAge: must match ${DURATION_RE.source} (e.g. "5m"), got ${JSON.stringify(syncMaxAge)}`)
  }

  const retention = raw.retention ?? DEFAULT_RETENTION
  if (typeof retention !== 'string' || !(retention === 'claude' || retention === 'forever' || DURATION_RE.test(retention))) {
    throw new ConfigError(`retention: must be "claude", "forever" or a duration (e.g. "90d"), got ${JSON.stringify(retention)}`)
  }

  const store = raw.store ?? DEFAULT_STORE
  if (store !== 'full' && store !== 'usage') throw new ConfigError(`store: must be "full" or "usage", got ${JSON.stringify(store)}`)
  // A slimmed mirror can only be fetched again in full while the host still has the files.
  if (store === 'usage' && retention === 'forever') throw new ConfigError('store: "usage" cannot be used with retention "forever"')

  const rawHosts = raw.hosts ?? []
  if (!Array.isArray(rawHosts)) throw new ConfigError('hosts: must be an array')
  const seen = new Set<string>()
  const hosts = rawHosts.map((entry, i): HostConfig => {
    const at = `hosts[${i}]`
    if (!isObject(entry)) throw new ConfigError(`${at}: must be an object`)
    rejectUnknownKeys(entry, ['name', 'ssh', 'paths'], `${at}.`)

    if (typeof entry.name !== 'string') throw new ConfigError(`${at}.name: must be a string`)
    validateHostName(entry.name, `${at}.name`)
    if (seen.has(entry.name)) throw new ConfigError(`${at}.name: duplicate host name '${entry.name}'`)
    seen.add(entry.name)

    if (typeof entry.ssh !== 'string' || entry.ssh.trim() === '') throw new ConfigError(`${at}.ssh: must be a non-empty string`)

    const host: HostConfig = { name: entry.name, ssh: entry.ssh }
    if (entry.paths !== undefined) {
      if (!Array.isArray(entry.paths) || entry.paths.length === 0) throw new ConfigError(`${at}.paths: must be a non-empty array of strings`)
      host.paths = entry.paths.map((path, j) => {
        if (typeof path !== 'string' || normalizeRemotePath(path) === '') throw new ConfigError(`${at}.paths[${j}]: must be a non-empty string`)
        return normalizeRemotePath(path)
      })
    }
    return host
  })

  return { version: 1, syncMaxAge, retention, store, hosts }
}

/** A missing file means no hosts. */
export function loadConfig(file: string): Config {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyConfig()
    throw error
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new ConfigError(`${file}: invalid JSON: ${(error as Error).message}`)
  }
  try {
    return validateConfig(raw)
  } catch (error) {
    if (error instanceof ConfigError) throw new ConfigError(`${file}: ${error.message}`)
    throw error
  }
}

/** Atomic: write a temp file next to it, then rename over it. */
export function saveConfig(file: string, config: Config): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`)
  renameSync(tmp, file)
}

/** `user@Host.example.com:22` → `host`. ssh aliases are not resolved. */
export function reduceHostname(value: string): string {
  let host = value.trim().replace(/^ssh:\/\//, '')
  host = host.slice(host.lastIndexOf('@') + 1)
  host = host.replace(/:\d*$/, '')
  return host.split('.')[0]!.toLowerCase()
}

/** True if this host entry is the machine we're running on, so one config can be copied everywhere. */
export function isLocalHost(host: HostConfig, localHostname: string): boolean {
  const local = reduceHostname(localHostname)
  return local !== '' && (host.name === local || reduceHostname(host.ssh) === local)
}
