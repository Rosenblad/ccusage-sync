import { type ChildProcess, spawn } from 'node:child_process'
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import pc from 'picocolors'
import { isStatusline } from './argv.js'
import { type HostConfig, hostPaths } from './config.js'
import { hostDir, slotDir } from './paths.js'
import { PRUNE_MARGIN_MS } from './retention.js'

export const SSH_OPTIONS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10']
export const SSH_COMMAND = ['ssh', ...SSH_OPTIONS].join(' ')
export const MAX_PARALLEL_HOSTS = 4
export const STALE_LOCK_MS = 10 * 60_000
export const STALE_BREAKER_MS = 10_000

export interface RunResult {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  error?: NodeJS.ErrnoException
}

/** Runs a command, writing `input` to its stdin if given. */
export type Runner = (command: string, args: string[], input?: string) => Promise<RunResult>

/** Runs a command with its output captured. Live children are tracked so they can be signalled. */
export function createRunner(children: Set<ChildProcess> = new Set()): Runner {
  return (command, args, input) =>
    new Promise((resolve) => {
      const child = spawn(command, args, { stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] })
      children.add(child)
      // A child that exits without reading all its input makes the write fail with EPIPE: its exit code tells the story.
      child.stdin?.on('error', () => {})
      child.stdin?.end(input)
      let stdout = ''
      let stderr = ''
      child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
        stdout += chunk
      })
      child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
        stderr += chunk
      })
      child.on('error', (error) => {
        children.delete(child)
        resolve({ code: null, signal: null, stdout, stderr, error })
      })
      child.on('close', (code, signal) => {
        children.delete(child)
        resolve({ code, signal, stdout, stderr })
      })
    })
}

export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./~-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * The script `ssh <host> sh -s` runs to list the transcripts to fetch: for path i, a line `i ./<file>` per `*.jsonl` file
 * modified within the retention window (every file if undefined), or `i missing` if the path doesn't exist. It is fed
 * on stdin to `sh`, so it works whatever the login shell is.
 */
export function listScript(paths: string[], retentionMs: number | undefined): string {
  const age = retentionMs === undefined ? '' : ` -mmin -${Math.ceil(retentionMs / 60_000)}`
  return paths
    .map((path, i) => `(cd ${shellQuote(path)} 2>/dev/null && find . -type f -name '*.jsonl'${age} | sed 's/^/${i} /') || echo '${i} missing'\n`)
    .join('')
}

/** Splits listScript's output by path: the files to fetch (relative to the path), or undefined if the path is missing. */
export function parseListing(stdout: string, count: number): (string[] | undefined)[] {
  const lists: (string[] | undefined)[] = Array.from({ length: count }, () => [])
  for (const line of stdout.split('\n')) {
    const match = /^(\d+) (.*)$/.exec(line)
    const i = Number(match?.[1])
    if (!match || !(i < count)) continue
    if (match[2] === 'missing') lists[i] = undefined
    else lists[i]?.push(match[2]!.replace(/^\.\//, ''))
  }
  return lists
}

/**
 * Fetches the files listed on stdin. No `--delete` (keeps history the remote has pruned), no `--partial` (never leaves a
 * truncated file in place). `-a` keeps the remote modification times, which retention goes by.
 */
export function rsyncArgs(ssh: string, remotePath: string, dest: string): string[] {
  return ['-az', '--files-from=-', '-e', SSH_COMMAND, `${ssh}:${remotePath.replace(/\/+$/, '')}/`, `${dest}/`]
}

// --- state.json ---

export interface HostState {
  lastAttempt: string | null
  lastSuccess: string | null
  lastError: string | null
}

const EMPTY_STATE: HostState = { lastAttempt: null, lastSuccess: null, lastError: null }

export function readState(dir: string): HostState {
  try {
    const raw = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as Partial<HostState>
    return { ...EMPTY_STATE, ...raw }
  } catch {
    return { ...EMPTY_STATE }
  }
}

export function writeState(dir: string, state: HostState): void {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'state.json')
  writeFileSync(`${file}.tmp`, `${JSON.stringify(state, null, 2)}\n`)
  renameSync(`${file}.tmp`, file)
}

/** Gated on the last attempt, so an offline host costs at most one connect timeout per window. */
export function needsSync(state: HostState, maxAgeMs: number, now: Date): boolean {
  if (!state.lastAttempt) return true
  const age = now.getTime() - Date.parse(state.lastAttempt)
  return Number.isNaN(age) || age < 0 || age >= maxAgeMs
}

/** ccusage's help and version flags, valid on every subcommand. */
const HELP_OR_VERSION = ['--help', '-h', '--version', '-v']

/** The statusline never syncs: it must answer fast. Neither does asking ccusage for help or its version. */
export function shouldSyncBeforeForward(args: string[], noSync: boolean): boolean {
  return !noSync && !isStatusline(args) && !args.some((arg) => HELP_OR_VERSION.includes(arg))
}

export function staleHosts(hosts: HostConfig[], data: string, maxAgeMs: number, now: Date): HostConfig[] {
  return hosts.filter((host) => needsSync(readState(hostDir(data, host.name)), maxAgeMs, now))
}

// --- lock ---

export interface Lock {
  release(): void
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Takes `<hostDir>/.lock` with an exclusive create. Returns undefined if another live run holds it.
 * A lock older than 10 minutes, unreadable, or left by a dead process is stale and taken over.
 */
export function acquireLock(
  dir: string,
  now: Date,
  isAlive: (pid: number) => boolean = isProcessAlive,
  pid: number = process.pid,
): Lock | undefined {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, '.lock')
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, 'wx')
      try {
        writeSync(fd, JSON.stringify({ pid, time: now.toISOString() }))
      } finally {
        closeSync(fd)
      }
      return {
        release: () => {
          try {
            unlinkSync(file)
          } catch {}
        },
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    if (!isStaleLock(file, now, isAlive) || !breakStaleLock(file, now, isAlive)) return undefined
  }
  return undefined
}

/**
 * Deletes a stale lock while holding `<lock>.break`, after checking again that it is stale. Without this, two runs that
 * both saw the same stale lock could each delete it, the second one deleting the lock the first had just taken.
 */
function breakStaleLock(file: string, now: Date, isAlive: (pid: number) => boolean): boolean {
  const breaker = `${file}.break`
  try {
    closeSync(openSync(breaker, 'wx'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    // Another run is breaking the lock, or one died while doing so (it takes microseconds): clear that for next time.
    try {
      if (Date.now() - statSync(breaker).mtimeMs > STALE_BREAKER_MS) unlinkSync(breaker)
    } catch {}
    return false
  }
  try {
    if (!isStaleLock(file, now, isAlive)) return false
    try {
      unlinkSync(file)
    } catch {}
    return true
  } finally {
    try {
      unlinkSync(breaker)
    } catch {}
  }
}

function isStaleLock(file: string, now: Date, isAlive: (pid: number) => boolean): boolean {
  try {
    const { pid, time } = JSON.parse(readFileSync(file, 'utf8')) as { pid?: unknown; time?: unknown }
    const age = now.getTime() - Date.parse(String(time))
    if (Number.isNaN(age) || age > STALE_LOCK_MS) return true
    return typeof pid === 'number' && !isAlive(pid)
  } catch (error) {
    // Released between our open and read: free, so retry.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    // Half-written by a concurrent run: leave it alone.
    return false
  }
}

// --- classification ---

type SlotKind = 'ok' | 'missing' | 'rsync-missing' | 'remote-rsync-missing' | 'auth' | 'unreachable' | 'other'

export interface SlotResult extends RunResult {
  path: string
  /** Set when the kind is known without classifying the result, e.g. from the listing. */
  kind?: SlotKind
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim()).find((line) => line !== '') ?? ''
}

export function classifySlot(result: RunResult): SlotKind {
  if (result.error?.code === 'ENOENT') return 'rsync-missing'
  // 24: some source files vanished mid-transfer (e.g. Claude Code rotating a file). The rest synced.
  if (result.code === 0 || result.code === 24) return 'ok'
  if (result.code === 255) return /Permission denied/.test(result.stderr) ? 'auth' : 'unreachable'
  // bash/sh: `rsync: command not found`; zsh (the macOS default shell): `command not found: rsync`.
  if (result.code === 127 || /rsync: (command )?not found|command not found: rsync/.test(result.stderr)) return 'remote-rsync-missing'
  if (result.code === 23 || /No such file/.test(result.stderr)) return 'missing'
  return 'other'
}

const AUTH_FAILED = 'SSH auth failed (key-based auth required, BatchMode)'

/** Why listing the host's transcripts failed. */
export function listingFailure(result: RunResult): string {
  if (result.error) return `cannot run ssh: ${result.error.message}`
  if (result.code === 255) return /Permission denied/.test(result.stderr) ? AUTH_FAILED : withDetail('cannot reach host', result.stderr)
  const exit = result.signal ? `signal ${result.signal}` : `exit ${result.code}`
  return withDetail(`listing logs on host failed (${exit})`, result.stderr)
}

/** Slot kinds after which the host's remaining slots would fail the same way. */
const FATAL_KINDS: SlotKind[] = ['rsync-missing', 'auth', 'unreachable', 'remote-rsync-missing']

/** Returns undefined if the host synced (at least one slot did), else the failure message. */
export function hostFailure(slots: SlotResult[]): string | undefined {
  const kinds = slots.map((slot) => slot.kind ?? classifySlot(slot))
  if (kinds.includes('ok')) return undefined
  const find = (kind: SlotKind) => slots[kinds.indexOf(kind)]

  if (kinds.includes('rsync-missing')) {
    return 'rsync not found (install it: brew install rsync / apt install rsync)'
  }
  if (kinds.includes('auth')) return AUTH_FAILED
  const unreachable = find('unreachable')
  if (unreachable) return withDetail('cannot reach host', unreachable.stderr)
  if (kinds.includes('remote-rsync-missing')) return 'rsync not found on host (install rsync there)'
  if (kinds.length > 0 && kinds.every((kind) => kind === 'missing')) {
    return `no Claude Code logs on host at ${slots.map((slot) => slot.path).join(', ')}`
  }
  const other = find('other') ?? slots[0]
  if (!other) return 'no paths to sync'
  const exit = other.signal ? `signal ${other.signal}` : `exit ${other.code}`
  return withDetail(`rsync failed (${exit})`, other.stderr)
}

function withDetail(message: string, stderr: string): string {
  const detail = firstLine(stderr)
  return detail ? `${message}: ${detail}` : message
}

// --- sync ---

export function dirSize(dir: string): number {
  let total = 0
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) total += dirSize(path)
    else if (entry.isFile()) {
      try {
        total += statSync(path).size
      } catch {}
    }
  }
  return total
}

/**
 * Deletes mirrored transcripts last modified before `cutoffMs`, then the directories that leaves empty.
 * Returns the bytes freed.
 */
export function prune(dir: string, cutoffMs: number): number {
  let freed = 0
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      freed += prune(path, cutoffMs)
      try {
        rmdirSync(path) // Fails unless empty.
      } catch {}
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      try {
        const { mtimeMs, size } = statSync(path)
        if (mtimeMs < cutoffMs) {
          unlinkSync(path)
          freed += size
        }
      } catch {}
    }
  }
  return freed
}

export interface SyncDeps {
  dataDir: string
  run: Runner
  now: () => Date
  /** Keep mirrored transcripts modified within this window; undefined keeps them forever. */
  retentionMs?: number
  isAlive?: (pid: number) => boolean
  /** Set once a signal arrives; hosts not yet started are skipped and nothing more is recorded. */
  interrupted?: () => boolean
}

export type HostOutcome =
  | { name: string; status: 'ok'; bytesAdded: number; bytesPruned: number; durationMs: number }
  | { name: string; status: 'failed'; error: string; lastSuccess: string | null }
  | { name: string; status: 'locked' }
  | { name: string; status: 'interrupted' }

export async function syncHost(host: HostConfig, deps: SyncDeps): Promise<HostOutcome> {
  const dir = hostDir(deps.dataDir, host.name)
  const lock = acquireLock(dir, deps.now(), deps.isAlive)
  if (!lock) return { name: host.name, status: 'locked' }
  try {
    const started = deps.now()
    const paths = hostPaths(host)
    const projectsDir = (path: string) => join(slotDir(deps.dataDir, host.name, path), 'projects')
    let error: string | undefined
    let bytesAdded = 0

    const listing = await deps.run('ssh', [...SSH_OPTIONS, host.ssh, 'sh', '-s'], listScript(paths, deps.retentionMs))
    if (listing.code !== 0) {
      error = listingFailure(listing)
    } else {
      const lists = parseListing(listing.stdout, paths.length)
      const slots: SlotResult[] = []
      for (const [i, path] of paths.entries()) {
        if (deps.interrupted?.()) break
        const files = lists[i]
        if (!files?.length) {
          slots.push({ code: 0, signal: null, stdout: '', stderr: '', path, kind: files ? 'ok' : 'missing' })
          continue
        }
        const projects = projectsDir(path)
        mkdirSync(projects, { recursive: true })
        const before = dirSize(projects)
        const result = await deps.run('rsync', rsyncArgs(host.ssh, path, projects), `${files.join('\n')}\n`)
        bytesAdded += dirSize(projects) - before
        // The listing found this path, so a file missing now vanished after it was listed: that's not a missing path.
        const kind = classifySlot(result)
        slots.push({ ...result, path, kind: kind === 'missing' ? 'other' : kind })
        if (result.signal || FATAL_KINDS.includes(kind)) break
      }
      error = hostFailure(slots)
    }
    if (deps.interrupted?.()) return { name: host.name, status: 'interrupted' }

    // Pruned even when the host can't be reached: retention is about the age of what is kept here.
    let bytesPruned = 0
    if (deps.retentionMs !== undefined) {
      const cutoff = deps.now().getTime() - deps.retentionMs - PRUNE_MARGIN_MS
      for (const path of paths) bytesPruned += prune(projectsDir(path), cutoff)
    }

    const finished = deps.now()
    const previous = readState(dir)
    const state: HostState = {
      lastAttempt: started.toISOString(),
      lastSuccess: error ? previous.lastSuccess : finished.toISOString(),
      lastError: error ?? null,
    }
    writeState(dir, state)
    if (error) return { name: host.name, status: 'failed', error, lastSuccess: state.lastSuccess }
    return { name: host.name, status: 'ok', bytesAdded, bytesPruned, durationMs: finished.getTime() - started.getTime() }
  } finally {
    lock.release()
  }
}

/** Syncs up to 4 hosts at a time, reporting each as it finishes. */
export async function syncHosts(
  hosts: HostConfig[],
  deps: SyncDeps,
  onDone: (outcome: HostOutcome) => void = () => {},
): Promise<HostOutcome[]> {
  const outcomes: HostOutcome[] = []
  const queue = [...hosts]
  const worker = async () => {
    for (let host = queue.shift(); host; host = queue.shift()) {
      const outcome = deps.interrupted?.() ? { name: host.name, status: 'interrupted' as const } : await syncHost(host, deps)
      outcomes.push(outcome)
      onDone(outcome)
    }
  }
  await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL_HOSTS, hosts.length) }, worker))
  return hosts.map((host) => outcomes.find((outcome) => outcome.name === host.name)!)
}

// --- output ---

export function formatBytes(bytes: number): string {
  return `${bytes < 0 ? '-' : '+'}${formatSize(Math.abs(bytes))}`
}

export function formatSize(bytes: number): string {
  let value = bytes
  const units = ['B', 'KB', 'MB', 'GB']
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  const shown = unit === 0 || value >= 10 ? Math.round(value).toString() : value.toFixed(1)
  return `${shown} ${units[unit]}`
}

export function formatAgo(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86_400)}d ago`
}

/** The stderr line for a host, or undefined if nothing should be printed. Off a TTY only failures print. */
export function formatOutcome(outcome: HostOutcome, opts: { tty: boolean; now: Date; nameWidth: number }): string | undefined {
  const name = outcome.name.padEnd(opts.nameWidth)
  switch (outcome.status) {
    case 'ok': {
      if (!opts.tty) return undefined
      const pruned = outcome.bytesPruned > 0 ? `  ${pc.dim(`pruned ${formatSize(outcome.bytesPruned)}`)}` : ''
      return `${pc.green('✓')} ${name}  ${formatBytes(outcome.bytesAdded)}  ${(outcome.durationMs / 1000).toFixed(1)}s${pruned}`
    }
    case 'locked':
      return opts.tty ? `${pc.dim('·')} ${name}  ${pc.dim('sync already running elsewhere, using existing mirror')}` : undefined
    case 'interrupted':
      return undefined
    case 'failed': {
      const mirror = outcome.lastSuccess
        ? `using mirror from ${formatAgo(opts.now.getTime() - Date.parse(outcome.lastSuccess))}`
        : 'no mirror yet'
      const mark = opts.tty ? pc.red('✗') : 'ccusage-sync: ✗'
      return `${mark} ${name}  ${outcome.error} (${mirror})`
    }
  }
}
