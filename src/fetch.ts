/**
 * The slimmed store (`"store": "usage"`): transcripts are fetched append-only, by byte offset, and slimmed as they
 * arrive. rsync can't do this: it diffs against the local copy, and a slimmed copy is no basis for that.
 *
 * `<hostDir>/index.json` records, per mirrored file, how much of the remote file was consumed and how large the slimmed
 * copy is. A local file whose size doesn't match its entry (a crash mid-write, an edit) is fetched again in full, as is
 * every file when the index was written for another SLIM_FORMAT.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { slotName } from './paths.js'
import { completeLength, SLIM_FORMAT, type SlimState, slimChunk, slimFileInPlace } from './slim.js'
import { listingFailure, type RunResult, type Runner, SSH_OPTIONS, shellQuote, withDetail } from './sync.js'

// --- index ---

export interface FileEntry {
  /** Bytes of the remote file consumed, or null if the host no longer had the file when that was last checked. */
  offset: number | null
  /** Size of the slimmed local copy. */
  size: number
  sessionSettled: boolean
}

/** Slot directory name → path relative to the slot's projects/ → entry. */
export type Index = Record<string, Record<string, FileEntry>>

interface IndexFile {
  format: number
  slots: Index
}

const indexFile = (dir: string) => join(dir, 'index.json')

function readIndexFile(dir: string): IndexFile | undefined {
  try {
    const raw = JSON.parse(readFileSync(indexFile(dir), 'utf8')) as IndexFile
    if (typeof raw.format === 'number' && typeof raw.slots === 'object' && raw.slots !== null) return raw
  } catch {}
  return undefined
}

/** The index, or an empty one if it is missing, unreadable, or for another slim format. */
export function readIndex(dir: string): Index {
  const index = readIndexFile(dir)
  return index?.format === SLIM_FORMAT ? index.slots : {}
}

export function writeIndex(dir: string, slots: Index): void {
  const file = indexFile(dir)
  writeFileSync(`${file}.tmp`, `${JSON.stringify({ format: SLIM_FORMAT, slots } satisfies IndexFile)}\n`)
  renameSync(`${file}.tmp`, file)
}

/** Every `*.jsonl` under `dir`, relative to it. Leftover `*.jsonl.tmp` files from an interrupted run are deleted. */
export function localTranscripts(dir: string): string[] {
  let entries
  try {
    entries = readdirSync(dir, { recursive: true, withFileTypes: true })
  } catch {
    return []
  }
  const files: string[] = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const path = join(entry.parentPath, entry.name)
    if (entry.name.endsWith('.jsonl')) files.push(relative(dir, path))
    else if (entry.name.endsWith('.jsonl.tmp')) {
      try {
        unlinkSync(path)
      } catch {}
    }
  }
  return files.sort()
}

function localSize(file: string): number | undefined {
  try {
    return statSync(file).size
  } catch {
    return undefined
  }
}

/** Whether the local copy is exactly what its entry describes. */
function isTracked(file: string, entry: FileEntry | undefined): entry is FileEntry {
  return entry !== undefined && localSize(file) === entry.size
}

// --- migration ---

/**
 * Slims a full mirror in place, without fetching anything: each file's offset is its current size up to its last
 * newline. Files still slimmed from an earlier spell in this store (their size matches their old entry) are left
 * alone: as they are if the format is current, else untracked, so they are fetched again.
 *
 * Slimmed copies are written next to the originals and only renamed over them once the index is saved, so an
 * interrupted migration leaves either the full mirror, or an index whose size checks catch any file not renamed.
 */
export function migrateToUsage(dir: string, slots: string[]): void {
  const previous = readIndexFile(dir)
  const index: Index = {}
  const pending: [string, string][] = []
  for (const slot of slots) {
    const projects = join(dir, slot, 'projects')
    const entries: Record<string, FileEntry> = (index[slot] = {})
    for (const rel of localTranscripts(projects)) {
      const file = join(projects, rel)
      const was = previous?.slots[slot]?.[rel]
      if (isTracked(file, was)) {
        if (previous!.format === SLIM_FORMAT) entries[rel] = was
        continue
      }
      const tmp = `${file}.tmp`
      writeFileSync(tmp, readFileSync(file))
      const { atime, mtime } = statSync(file)
      utimesSync(tmp, atime, mtime)
      entries[rel] = slimFileInPlace(tmp)
      pending.push([tmp, file])
    }
  }
  writeIndex(dir, index)
  for (const [tmp, file] of pending) renameSync(tmp, file)
}

// --- listing ---

export interface RemoteFile {
  /** Relative to the remote path. */
  path: string
  size: number
  mtimeMs: number
}

/**
 * Like listScript, with each file's size and modification time: `i <size> <mtime> ./<file>`. POSIX has no way to read
 * a modification time, so this uses stat, in its GNU and busybox form or else its BSD form. `retentionMs` undefined
 * lists every file.
 */
export function statListScript(paths: string[], retentionMs: number | undefined): string {
  const age = retentionMs === undefined ? '' : ` -mmin -${Math.ceil(retentionMs / 60_000)}`
  const find = `find . -type f -name '*.jsonl'${age}`
  return [
    'if stat -c %Y . >/dev/null 2>&1; then',
    `  st() { ${find} -exec stat -c '%s %Y %n' {} +; }`,
    'elif stat -f %m . >/dev/null 2>&1; then',
    `  st() { ${find} -exec stat -f '%z %m %N' {} +; }`,
    'else',
    "  echo 'stat not found on host' >&2; exit 3",
    'fi',
    ...paths.map((path, i) => `(cd ${shellQuote(path)} 2>/dev/null && st | sed 's/^/${i} /') || echo '${i} missing'`),
    '',
  ].join('\n')
}

export function parseStatListing(stdout: string, count: number): (RemoteFile[] | undefined)[] {
  const lists: (RemoteFile[] | undefined)[] = Array.from({ length: count }, () => [])
  for (const line of stdout.split('\n')) {
    const missing = /^(\d+) missing$/.exec(line)
    if (missing) {
      if (Number(missing[1]) < count) lists[Number(missing[1])] = undefined
      continue
    }
    const match = /^(\d+) (\d+) (\d+) \.\/(.+)$/.exec(line)
    if (!match || !(Number(match[1]) < count)) continue
    lists[Number(match[1])]?.push({ path: match[4]!, size: Number(match[2]), mtimeMs: Number(match[3]) * 1000 })
  }
  return lists
}

// --- fetching ---

/** Printed before the frames, so anything a login script prints first can be skipped. */
export const FETCH_MARKER = 'ccusage-sync-fetch-1'

export interface FetchRequest {
  /** Relative to the remote home. */
  remotePath: string
  /** 0-based byte to start at. */
  start: number
}

/**
 * The script `ssh <host> sh -s` runs to send the requested bytes: after FETCH_MARKER, for request i a line `i <n>`
 * followed by n bytes, from `start` to the end of the file as it is then (0 bytes if it vanished). Each file is copied
 * to a temp file first, so the length is known before its bytes are sent.
 */
export function fetchScript(requests: FetchRequest[]): string {
  return [
    't=$(mktemp) || exit 1',
    `trap 'rm -f "$t"' EXIT`,
    `f() { tail -c +"$2" "$1" > "$t" 2>/dev/null || : > "$t"; echo "$3 $(($(wc -c < "$t")))"; cat "$t"; }`,
    `echo ${FETCH_MARKER}`,
    ...requests.map((request, i) => `f ${shellQuote(request.remotePath)} ${request.start + 1} ${i}`),
    '',
  ].join('\n')
}

export interface FrameHandler {
  start(id: number, length: number): void
  data(id: number, chunk: Buffer): void
  end(id: number): void
}

/** Splits fetchScript's output into its frames. */
export class FrameParser {
  private pending: Buffer = Buffer.alloc(0)
  private seenMarker = false
  private current: { id: number; left: number } | undefined
  constructor(private readonly handler: FrameHandler) {}

  push(chunk: Buffer): void {
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk])
    for (;;) {
      if (this.current) {
        const take = Math.min(this.current.left, this.pending.length)
        if (take > 0) this.handler.data(this.current.id, this.pending.subarray(0, take))
        this.pending = this.pending.subarray(take)
        this.current.left -= take
        if (this.current.left > 0) return
        this.handler.end(this.current.id)
        this.current = undefined
      }
      const newline = this.pending.indexOf(0x0a)
      if (newline === -1) return
      const line = this.pending.subarray(0, newline).toString()
      this.pending = this.pending.subarray(newline + 1)
      if (!this.seenMarker) {
        this.seenMarker = line === FETCH_MARKER
        continue
      }
      const match = /^(\d+) (\d+)$/.exec(line)
      if (!match) throw new Error(`unexpected output from host: ${JSON.stringify(line.slice(0, 80))}`)
      this.current = { id: Number(match[1]), left: Number(match[2]) }
      this.handler.start(this.current.id, this.current.left)
    }
  }

  /** Whether the output ended between frames. */
  get complete(): boolean {
    return this.seenMarker && !this.current && this.pending.length === 0
  }
}

/** Runs a command, streaming its stdout to `onStdout`; the result's stdout is left empty. */
export type StreamRunner = (command: string, args: string[], input: string, onStdout: (chunk: Buffer) => void) => Promise<RunResult>

export function createStreamRunner(children: Set<ChildProcess> = new Set()): StreamRunner {
  return (command, args, input, onStdout) =>
    new Promise((resolve) => {
      const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })
      children.add(child)
      child.stdin.on('error', () => {})
      child.stdin.end(input)
      let stderr = ''
      let failure: Error | undefined
      child.stdout.on('data', (chunk: Buffer) => {
        if (failure) return
        try {
          onStdout(chunk)
        } catch (error) {
          failure = error as Error
          child.kill()
        }
      })
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        stderr += chunk
      })
      child.on('error', (error) => {
        children.delete(child)
        resolve({ code: null, signal: null, stdout: '', stderr, error })
      })
      child.on('close', (code, signal) => {
        children.delete(child)
        if (failure) resolve({ code: null, signal: null, stdout: '', stderr: failure.message })
        else resolve({ code, signal, stdout: '', stderr })
      })
    })
}

/** One file to fetch: its local copy, where its remote bytes start, and its modification time there. */
export interface Plan {
  slot: string
  rel: string
  local: string
  remotePath: string
  /** Bytes of the remote file already consumed; 0 fetches it in full. */
  offset: number
  mtimeMs: number
}

interface Receiving {
  plan: Plan
  /** Bytes of the frame seen so far. An append's frame starts one byte early, at the newline the last fetch ended on. */
  received: number
  fd: number | undefined
  carry: Buffer
  consumed: number
  written: number
  state: SlimState
}

export interface FetchOutcome {
  result: RunResult
  /** Appends whose remote file no longer ends where the last fetch did: fetch them again in full. */
  rewritten: Plan[]
  bytesAdded: number
}

/**
 * Fetches and slims the planned files over one connection, updating `index` for each file completed. A new file is
 * written to a temp file and renamed into place; an append is added to the existing copy. Either way the local
 * modification time is set to the remote one.
 */
export async function fetchPlans(
  stream: StreamRunner,
  sshArgs: string[],
  plans: Plan[],
  index: Index,
): Promise<FetchOutcome> {
  const receiving = new Map<number, Receiving>()
  const rewritten: Plan[] = []
  let bytesAdded = 0

  const write = (r: Receiving, data: Buffer) => {
    if (data.length === 0) return
    if (r.fd === undefined) {
      mkdirSync(dirname(r.plan.local), { recursive: true })
      r.fd = openSync(r.plan.offset === 0 ? `${r.plan.local}.tmp` : r.plan.local, r.plan.offset === 0 ? 'w' : 'a')
    }
    writeSync(r.fd, data)
    r.written += data.length
  }

  const parser = new FrameParser({
    start(id) {
      const plan = plans[id]!
      const entry = index[plan.slot]?.[plan.rel]
      receiving.set(id, {
        plan,
        received: 0,
        fd: undefined,
        carry: Buffer.alloc(0),
        consumed: plan.offset,
        written: 0,
        state: { sessionSettled: plan.offset !== 0 && (entry?.sessionSettled ?? false) },
      })
    },
    data(id, chunk) {
      const r = receiving.get(id)
      if (!r) return
      let data = chunk
      if (r.received === 0 && r.plan.offset !== 0) {
        if (data[0] !== 0x0a) {
          receiving.delete(id)
          rewritten.push(r.plan)
          return
        }
        data = data.subarray(1)
      }
      r.received += chunk.length
      const joined = r.carry.length === 0 ? data : Buffer.concat([r.carry, data])
      const complete = completeLength(joined)
      write(r, slimChunk(joined.subarray(0, complete), r.state))
      r.consumed += complete
      r.carry = Buffer.from(joined.subarray(complete))
    },
    end(id) {
      const r = receiving.get(id)
      if (!r) return
      receiving.delete(id)
      const { plan } = r
      if (r.fd !== undefined) closeSync(r.fd)
      // Nothing came back: the file vanished or shrank since it was listed. The copy stays as it is until the next listing.
      if (r.received === 0) return
      const before = plan.offset === 0 ? (localSize(plan.local) ?? 0) : index[plan.slot]![plan.rel]!.size
      if (plan.offset === 0) {
        if (r.fd === undefined) {
          mkdirSync(dirname(plan.local), { recursive: true })
          writeFileSync(`${plan.local}.tmp`, '')
        }
        renameSync(`${plan.local}.tmp`, plan.local)
      }
      const time = new Date(plan.mtimeMs)
      utimesSync(plan.local, time, time)
      const size = plan.offset === 0 ? r.written : before + r.written
      ;(index[plan.slot] ??= {})[plan.rel] = { offset: r.consumed, size, sessionSettled: r.state.sessionSettled }
      bytesAdded += size - before
    },
  })

  const requests = plans.map((plan) => ({ remotePath: plan.remotePath, start: Math.max(0, plan.offset - 1) }))
  const result = await stream('ssh', sshArgs, fetchScript(requests), (chunk) => parser.push(chunk))
  // Files cut off mid-frame are left as they were; their temp files are cleaned up next time.
  for (const r of receiving.values()) if (r.fd !== undefined) closeSync(r.fd)
  if (result.code === 0 && !result.error && !parser.complete) {
    return { result: { ...result, code: null, stderr: 'output from host ended early' }, rewritten, bytesAdded }
  }
  return { result, rewritten, bytesAdded }
}

/** What to fetch for one listed file, given its local copy; undefined if the copy is up to date. */
export function planFor(slot: string, projects: string, remoteRoot: string, file: RemoteFile, entry: FileEntry | undefined): Plan | undefined {
  const local = join(projects, file.path)
  const base = { slot, rel: file.path, local, remotePath: `${remoteRoot.replace(/\/+$/, '')}/${file.path}`, mtimeMs: file.mtimeMs }
  if (!isTracked(local, entry) || entry.offset === null || file.size < entry.offset) return { ...base, offset: 0 }
  if (file.size > entry.offset) return { ...base, offset: entry.offset }
  // Nothing new; the modification time may still have moved.
  if (Math.abs(statSync(local).mtimeMs - file.mtimeMs) >= 1000) utimesSync(local, new Date(file.mtimeMs), new Date(file.mtimeMs))
  return undefined
}

// --- sync ---

export interface UsageSyncDeps {
  run: Runner
  stream: StreamRunner
  now: () => Date
  retentionMs: number | undefined
  interrupted?: () => boolean
}

/** Everything slimmed must still exist on the host for a new SLIM_FORMAT to fetch it again. */
export const USAGE_NEEDS_RETENTION = 'store "usage" needs a retention window, but retention resolves to forever here'

/** Why fetching failed. */
export function fetchFailure(result: RunResult): string {
  if (result.error) return `cannot run ssh: ${result.error.message}`
  if (result.code === 255) return listingFailure(result)
  if (result.code === null && !result.signal) return withDetail('fetching logs failed', result.stderr)
  const exit = result.signal ? `signal ${result.signal}` : `exit ${result.code}`
  return withDetail(`fetching logs failed (${exit})`, result.stderr)
}

/**
 * Syncs a host into the slimmed store (already migrated): lists the host with sizes, then fetches and slims the new
 * bytes of each file. Returns the failure message, if any.
 */
export async function syncUsage(
  ssh: string,
  dir: string,
  paths: string[],
  deps: UsageSyncDeps,
): Promise<{ error?: string; bytesAdded: number }> {
  if (deps.retentionMs === undefined) return { error: USAGE_NEEDS_RETENTION, bytesAdded: 0 }
  const slots = paths.map(slotName)
  const projectsOf = (slot: string) => join(dir, slot, 'projects')
  const index = readIndex(dir)
  const untracked = (slot: string, rel: string) => !isTracked(join(projectsOf(slot), rel), index[slot]?.[rel])

  // Copies the index doesn't vouch for (written for another format, or interrupted) are fetched again whatever their
  // age, so the host is listed in full.
  const listAll = slots.some((slot) => localTranscripts(projectsOf(slot)).some((rel) => untracked(slot, rel)))
  const listing = await deps.run('ssh', [...SSH_OPTIONS, ssh, 'sh', '-s'], statListScript(paths, listAll ? undefined : deps.retentionMs))
  if (listing.code !== 0) return { error: listingFailure(listing), bytesAdded: 0 }
  const lists = parseStatListing(listing.stdout, paths.length)
  if (lists.every((list) => list === undefined)) return { error: `no Claude Code logs on host at ${paths.join(', ')}`, bytesAdded: 0 }

  const cutoff = deps.now().getTime() - deps.retentionMs
  const plans: Plan[] = []
  for (const [i, list] of lists.entries()) {
    if (!list) continue
    const slot = slots[i]!
    const projects = projectsOf(slot)
    for (const file of list) {
      // Outside the window (listed in full): fetched only to replace an untracked copy.
      if (file.mtimeMs < cutoff && !(existsSync(join(projects, file.path)) && untracked(slot, file.path))) continue
      const plan = planFor(slot, projects, paths[i]!, file, index[slot]?.[file.path])
      if (plan) plans.push(plan)
    }
    if (listAll) {
      // An untracked copy of a file the host no longer has is kept as it is, and no longer makes us list in full.
      const listed = new Set(list.map((file) => file.path))
      for (const rel of localTranscripts(projects)) {
        if (listed.has(rel) || !untracked(slot, rel)) continue
        ;(index[slot] ??= {})[rel] = { offset: null, size: statSync(join(projects, rel)).size, sessionSettled: false }
      }
    }
  }

  let error: string | undefined
  let bytesAdded = 0
  const sshArgs = [...SSH_OPTIONS, '-o', 'Compression=yes', ssh, 'sh', '-s']
  for (let round = plans; round.length > 0 && !deps.interrupted?.(); ) {
    const outcome = await fetchPlans(deps.stream, sshArgs, round, index)
    bytesAdded += outcome.bytesAdded
    if (outcome.result.code !== 0 || outcome.result.error) {
      error = fetchFailure(outcome.result)
      break
    }
    // Files rewritten since the last fetch are fetched again in full, once.
    round = round === plans ? outcome.rewritten.map((plan) => ({ ...plan, offset: 0 })) : []
  }
  writeIndex(dir, index)
  return { error, bytesAdded }
}

/** Drops index entries whose local copy is gone, e.g. pruned. */
export function forgetMissing(dir: string): void {
  const index = readIndex(dir)
  for (const [slot, files] of Object.entries(index)) {
    for (const rel of Object.keys(files)) if (!existsSync(join(dir, slot, 'projects', rel))) delete files[rel]
  }
  writeIndex(dir, index)
}
