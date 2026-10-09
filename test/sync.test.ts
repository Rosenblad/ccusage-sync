import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { HostConfig } from '../src/config.js'
import { hostDir, slotDir } from '../src/paths.js'
import {
  acquireLock,
  classifySlot,
  formatBytes,
  formatOutcome,
  hostFailure,
  listingFailure,
  listScript,
  needsSync,
  parseListing,
  prune,
  type RunResult,
  readState,
  rsyncArgs,
  type Runner,
  shellQuote,
  shouldSyncBeforeForward,
  type SlotResult,
  STALE_BREAKER_MS,
  STALE_LOCK_MS,
  staleHosts,
  syncHost,
  syncHosts,
  writeState,
} from '../src/sync.js'
import { tempDir } from './helpers.js'

const ok: RunResult = { code: 0, signal: null, stdout: '', stderr: '' }
const result = (code: number | null, stderr = '', extra: Partial<RunResult> = {}): RunResult => ({ code, signal: null, stdout: '', stderr, ...extra })
const slot = (path: string, r: RunResult): SlotResult => ({ ...r, path })

describe('rsyncArgs', () => {
  it('builds the exact argv', () => {
    expect(rsyncArgs('me@laptop', '.claude/projects', '/d/hosts/laptop/_claude_projects/projects')).toEqual([
      '-az',
      '--files-from=-',
      '-e',
      'ssh -o BatchMode=yes -o ConnectTimeout=10',
      'me@laptop:.claude/projects/',
      '/d/hosts/laptop/_claude_projects/projects/',
    ])
  })

  it('never deletes or keeps partial files', () => {
    const args = rsyncArgs('h', 'p', '/d')
    expect(args.some((arg) => arg.startsWith('--delete'))).toBe(false)
    expect(args.some((arg) => arg.startsWith('--partial') || arg === '-P')).toBe(false)
  })

  it('normalizes a trailing slash on the remote path', () => {
    expect(rsyncArgs('h', '/srv/projects/', '/d').at(-2)).toBe('h:/srv/projects/')
  })
})

describe('sync gating', () => {
  const now = new Date('2026-10-05T12:00:00Z')
  const maxAge = 5 * 60_000

  it('gates on lastAttempt, not lastSuccess', () => {
    const state = (lastAttempt: string | null) => ({ lastAttempt, lastSuccess: null, lastError: 'cannot reach host' })
    expect(needsSync(state(null), maxAge, now)).toBe(true)
    expect(needsSync(state('2026-10-05T11:56:00Z'), maxAge, now)).toBe(false)
    expect(needsSync(state('2026-10-05T11:55:00Z'), maxAge, now)).toBe(true)
    expect(needsSync(state('2026-10-05T13:00:00Z'), maxAge, now)).toBe(true) // clock went back
    expect(needsSync(state('garbage'), maxAge, now)).toBe(true)
  })

  it('selects only stale hosts', () => {
    const data = tempDir()
    writeState(hostDir(data, 'fresh'), { lastAttempt: '2026-10-05T11:59:00Z', lastSuccess: null, lastError: null })
    writeState(hostDir(data, 'old'), { lastAttempt: '2026-10-04T11:59:00Z', lastSuccess: null, lastError: null })
    const hosts = ['fresh', 'old', 'never'].map((name) => ({ name, ssh: name }))
    expect(staleHosts(hosts, data, maxAge, now).map((host) => host.name)).toEqual(['old', 'never'])
  })

  it('skips for statusline and --no-sync', () => {
    expect(shouldSyncBeforeForward(['claude', 'daily'], false)).toBe(true)
    expect(shouldSyncBeforeForward([], false)).toBe(true)
    expect(shouldSyncBeforeForward(['claude', 'daily'], true)).toBe(false)
    expect(shouldSyncBeforeForward(['statusline'], false)).toBe(false)
    expect(shouldSyncBeforeForward(['claude', 'statusline'], false)).toBe(false)
  })

  it('skips when asking ccusage for help or its version', () => {
    for (const flag of ['--help', '-h', '--version', '-v']) {
      expect(shouldSyncBeforeForward(['claude', 'daily', flag], false)).toBe(false)
    }
    expect(shouldSyncBeforeForward(['claude', 'daily', '--json'], false)).toBe(true)
  })
})

describe('state.json', () => {
  it('reads defaults when missing or corrupt', () => {
    const dir = tempDir()
    expect(readState(dir)).toEqual({ lastAttempt: null, lastSuccess: null, lastError: null })
    writeFileSync(join(dir, 'state.json'), '{')
    expect(readState(dir)).toEqual({ lastAttempt: null, lastSuccess: null, lastError: null })
  })
})

describe('acquireLock', () => {
  const now = new Date('2026-10-05T12:00:00Z')
  const alive = () => true

  it('takes a free lock and releases it', () => {
    const dir = join(tempDir(), 'host')
    const lock = acquireLock(dir, now, alive, 123)
    expect(lock).toBeDefined()
    expect(JSON.parse(readFileSync(join(dir, '.lock'), 'utf8'))).toEqual({ pid: 123, time: now.toISOString() })
    lock!.release()
    expect(existsSync(join(dir, '.lock'))).toBe(false)
  })

  it('refuses a lock held by a live process', () => {
    const dir = tempDir()
    const held = acquireLock(dir, now, alive, 1)
    expect(acquireLock(dir, now, alive, 2)).toBeUndefined()
    held!.release()
    expect(acquireLock(dir, now, alive, 2)).toBeDefined()
  })

  it('takes over a lock older than 10 minutes', () => {
    const dir = tempDir()
    acquireLock(dir, new Date(now.getTime() - STALE_LOCK_MS - 1000), alive, 1)
    expect(acquireLock(dir, now, alive, 2)).toBeDefined()
    expect(JSON.parse(readFileSync(join(dir, '.lock'), 'utf8')).pid).toBe(2)
  })

  it('takes over a lock left by a dead process', () => {
    const dir = tempDir()
    acquireLock(dir, now, alive, 1)
    expect(acquireLock(dir, now, (pid) => pid !== 1, 2)).toBeDefined()
  })

  it('leaves a half-written lock alone', () => {
    const dir = tempDir()
    writeFileSync(join(dir, '.lock'), '{"pid":')
    expect(acquireLock(dir, now, alive, 2)).toBeUndefined()
  })

  it('does not delete a lock another run took over in the meantime', () => {
    const dir = tempDir()
    acquireLock(dir, now, alive, 1)
    // Run 3 finds pid 1 dead; while it decides, run 2 also finds it dead and takes the lock.
    let raced = false
    const isAlive = (pid: number) => {
      if (pid === 1 && !raced) {
        raced = true
        expect(acquireLock(dir, now, (p) => p !== 1, 2)).toBeDefined()
      }
      return pid !== 1
    }
    expect(acquireLock(dir, now, isAlive, 3)).toBeUndefined()
    expect(JSON.parse(readFileSync(join(dir, '.lock'), 'utf8')).pid).toBe(2)
    expect(existsSync(join(dir, '.lock.break'))).toBe(false)
  })

  it('backs off while another run is breaking the lock, and clears a breaker left behind', () => {
    const dir = tempDir()
    acquireLock(dir, now, alive, 1)
    const breaker = join(dir, '.lock.break')
    writeFileSync(breaker, '')
    expect(acquireLock(dir, now, (pid) => pid !== 1, 2)).toBeUndefined()
    expect(existsSync(breaker)).toBe(true)
    const old = new Date(Date.now() - STALE_BREAKER_MS - 1000)
    utimesSync(breaker, old, old)
    expect(acquireLock(dir, now, (pid) => pid !== 1, 2)).toBeUndefined()
    expect(existsSync(breaker)).toBe(false)
    expect(acquireLock(dir, now, (pid) => pid !== 1, 2)).toBeDefined()
  })
})

describe('error classification', () => {
  it('rsync not found', () => {
    const enoent = Object.assign(new Error('spawn rsync ENOENT'), { code: 'ENOENT' })
    expect(hostFailure([slot('p', result(null, '', { error: enoent }))])).toMatch(/^rsync not found.*brew install rsync.*apt install rsync/)
  })

  it('ssh auth failure', () => {
    expect(hostFailure([slot('p', result(255, 'me@h: Permission denied (publickey).'))])).toBe(
      'SSH auth failed (key-based auth required, BatchMode)',
    )
  })

  it('unreachable host, with ssh stderr', () => {
    expect(hostFailure([slot('p', result(255, 'ssh: connect to host h port 22: Operation timed out\r\nrsync: connection unexpectedly closed\n'))])).toBe(
      'cannot reach host: ssh: connect to host h port 22: Operation timed out',
    )
  })

  it('no logs when every slot is missing', () => {
    expect(
      hostFailure([
        slot('.claude/projects', result(23, 'rsync: change_dir ".claude/projects" failed: No such file or directory (2)')),
        slot('.config/claude/projects', result(23)),
      ]),
    ).toBe('no Claude Code logs on host at .claude/projects, .config/claude/projects')
    expect(hostFailure([slot('p', result(2, 'rsync: [sender] link_stat "/x" failed: No such file or directory'))])).toMatch(/^no Claude Code logs/)
  })

  it('anything else', () => {
    expect(hostFailure([slot('p', result(12, 'rsync: protocol data stream error\nmore'))])).toBe(
      'rsync failed (exit 12): rsync: protocol data stream error',
    )
    expect(hostFailure([slot('p', result(null, '', { signal: 'SIGKILL' }))])).toBe('rsync failed (signal SIGKILL)')
  })

  it('rsync missing on the remote', () => {
    expect(hostFailure([slot('p', result(127, 'bash: rsync: command not found'))])).toMatch(/^rsync not found on host/)
    expect(hostFailure([slot('p', result(12, 'zsh:1: command not found: rsync'))])).toMatch(/^rsync not found on host/)
  })

  it('a missing slot does not fail a host with another good slot', () => {
    expect(hostFailure([slot('a', result(23, 'No such file or directory')), slot('b', ok)])).toBeUndefined()
  })

  it('treats vanished source files (24) as synced', () => {
    expect(classifySlot(result(24))).toBe('ok')
  })

  it('a failed listing', () => {
    expect(listingFailure(result(255, 'me@h: Permission denied (publickey).'))).toBe('SSH auth failed (key-based auth required, BatchMode)')
    expect(listingFailure(result(255, 'ssh: Could not resolve hostname h'))).toBe('cannot reach host: ssh: Could not resolve hostname h')
    expect(listingFailure(result(2, 'sh: 1: find: not found'))).toBe('listing logs on host failed (exit 2): sh: 1: find: not found')
    const enoent = Object.assign(new Error('spawn ssh ENOENT'), { code: 'ENOENT' })
    expect(listingFailure(result(null, '', { error: enoent }))).toBe('cannot run ssh: spawn ssh ENOENT')
  })
})

interface Call {
  command: string
  args: string[]
  input: string | undefined
}

interface FakeHost {
  /** The host's transcripts per remote path, listed by the fake listing. A path not here is missing. */
  files?: Record<string, string[]>
  /** The listing's result, instead of listing `files`. */
  listing?: RunResult
  /** rsync's result per remote path, instead of writing each requested file into the slot. */
  rsync?: Record<string, RunResult>
}

/** Answers the listing from `files` and fetches the requested files, 1 KB each. Records every call. */
function fakeRunner(host: FakeHost): Runner & { calls: Call[] } {
  const calls: Call[] = []
  const run = (async (command: string, args: string[], input?: string) => {
    calls.push({ command, args, input })
    if (command === 'ssh') {
      if (host.listing) return host.listing
      // Answer each path's line of the script, in script order.
      const lines = input!.trimEnd().split('\n').map((line, i) => {
        const path = Object.keys(host.files ?? {}).find((p) => line.startsWith(`(cd ${shellQuote(p)} `))
        return path === undefined ? [`${i} missing`] : host.files![path]!.map((file) => `${i} ./${file}`)
      })
      return { ...ok, stdout: lines.flat().map((line) => `${line}\n`).join('') }
    }
    const remote = args.at(-2)!.split(':')[1]!.replace(/\/$/, '')
    if (host.rsync?.[remote]) return host.rsync[remote]
    const dest = args.at(-1)!
    for (const file of input!.trimEnd().split('\n')) {
      mkdirSync(dirname(join(dest, file)), { recursive: true })
      writeFileSync(join(dest, file), 'x'.repeat(1024))
    }
    return ok
  }) as Runner & { calls: Call[] }
  run.calls = calls
  return run
}

const DAY = 86_400_000

/** Writes a mirrored transcript last modified `ageMs` before `now`. */
function mirrored(data: string, remotePath: string, file: string, now: Date, ageMs: number): string {
  const path = join(slotDir(data, 'laptop', remotePath), 'projects', file)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, 'x'.repeat(100))
  const time = new Date(now.getTime() - ageMs)
  utimesSync(path, time, time)
  return path
}

describe('listScript', () => {
  /** Runs the script with `sh -s` in `home`, as `ssh <host> sh -s` would. */
  const list = (home: string, paths: string[], retentionMs?: number) => {
    const result = spawnSync('sh', ['-s'], { cwd: home, input: listScript(paths, retentionMs), encoding: 'utf8' })
    expect(result.status).toBe(0)
    return parseListing(result.stdout, paths.length).map((files) => files?.sort())
  }

  const home = () => {
    const dir = tempDir()
    const write = (file: string, ageMs = 0) => {
      mkdirSync(dirname(join(dir, file)), { recursive: true })
      writeFileSync(join(dir, file), '{}\n')
      const time = new Date(Date.now() - ageMs)
      utimesSync(join(dir, file), time, time)
    }
    write('.claude/projects/-p/a.jsonl')
    write('.claude/projects/-p/a/subagents/agent-x.jsonl')
    write('.claude/projects/-p/old.jsonl', 40 * DAY)
    write('.claude/projects/-p/notes.txt')
    write("odd dir's/projects/b.jsonl")
    return dir
  }

  it('lists every transcript under each path, and marks missing paths', () => {
    expect(list(home(), ['.claude/projects', '.config/claude/projects', "odd dir's/projects"])).toEqual([
      ['-p/a.jsonl', '-p/a/subagents/agent-x.jsonl', '-p/old.jsonl'],
      undefined,
      ['b.jsonl'],
    ])
  })

  it('lists only transcripts modified within the retention window', () => {
    expect(list(home(), ['.claude/projects'], 30 * DAY)).toEqual([['-p/a.jsonl', '-p/a/subagents/agent-x.jsonl']])
    expect(listScript(['p'], 30 * DAY)).toContain('-mmin -43200')
  })

  it('parses only lines for known paths', () => {
    expect(parseListing('motd\n0 ./a.jsonl\n7 ./b.jsonl\n1 missing\n', 2)).toEqual([['a.jsonl'], undefined])
  })
})

describe('prune', () => {
  it('deletes transcripts older than the cutoff and the directories that leaves empty', () => {
    const data = tempDir()
    const now = new Date()
    const old = mirrored(data, 'p', '-a/old.jsonl', now, 40 * DAY)
    const fresh = mirrored(data, 'p', '-b/fresh.jsonl', now, DAY)
    mirrored(data, 'p', '-b/s/subagents/old.jsonl', now, 40 * DAY)
    const projects = join(slotDir(data, 'laptop', 'p'), 'projects')
    expect(prune(projects, now.getTime() - 30 * DAY)).toBe(200)
    expect(existsSync(old)).toBe(false)
    expect(existsSync(join(projects, '-a'))).toBe(false)
    expect(existsSync(join(projects, '-b', 's'))).toBe(false)
    expect(existsSync(fresh)).toBe(true)
    expect(existsSync(projects)).toBe(true)
  })

  it('ignores a missing directory', () => {
    expect(prune(join(tempDir(), 'nope'), Date.now())).toBe(0)
  })
})

describe('syncHost', () => {
  const host: HostConfig = { name: 'laptop', ssh: 'me@laptop' }
  let clock = 0
  const now = () => new Date(Date.UTC(2026, 9, 5, 12) + (clock += 500))

  it('lists the host, then fetches only the listed files into each path\'s slot', async () => {
    const data = tempDir()
    const run = fakeRunner({ files: { '.claude/projects': ['-p/a.jsonl', '-p/a/subagents/x.jsonl'] } })
    const outcome = await syncHost(host, { dataDir: data, run, now })
    expect(outcome).toMatchObject({ name: 'laptop', status: 'ok', bytesAdded: 2048, bytesPruned: 0 })
    expect(run.calls.map((call) => [call.command, call.args.at(-1)])).toEqual([
      ['ssh', '-s'],
      ['rsync', `${slotDir(data, 'laptop', '.claude/projects')}/projects/`],
    ])
    expect(run.calls[0]!.args).toEqual(['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'me@laptop', 'sh', '-s'])
    expect(run.calls[1]!.input).toBe('-p/a.jsonl\n-p/a/subagents/x.jsonl\n')
    // No slot for the missing path.
    expect(existsSync(slotDir(data, 'laptop', '.config/claude/projects'))).toBe(false)
    const state = readState(hostDir(data, 'laptop'))
    expect(state.lastError).toBeNull()
    expect(state.lastSuccess).not.toBeNull()
    expect(existsSync(join(hostDir(data, 'laptop'), '.lock'))).toBe(false)
  })

  it('lists only within the retention window', async () => {
    const data = tempDir()
    const run = fakeRunner({ files: { '.claude/projects': [] } })
    await syncHost(host, { dataDir: data, run, now, retentionMs: 30 * DAY })
    expect(run.calls[0]!.input).toContain('-mmin -43200')
    await syncHost(host, { dataDir: data, run, now })
    expect(run.calls[1]!.input).not.toContain('-mmin')
  })

  it('a path with nothing to fetch is synced, not missing', async () => {
    const data = tempDir()
    const run = fakeRunner({ files: { '.claude/projects': [] } })
    expect(await syncHost(host, { dataDir: data, run, now })).toMatchObject({ status: 'ok', bytesAdded: 0 })
    expect(run.calls).toHaveLength(1)
  })

  it('fails when every path is missing', async () => {
    const run = fakeRunner({ files: {} })
    expect(await syncHost(host, { dataDir: tempDir(), run, now })).toMatchObject({
      status: 'failed',
      error: 'no Claude Code logs on host at .claude/projects, .config/claude/projects',
    })
  })

  it('records a failed listing and keeps the previous lastSuccess', async () => {
    const data = tempDir()
    writeState(hostDir(data, 'laptop'), { lastAttempt: 'x', lastSuccess: '2026-10-03T12:00:00.000Z', lastError: null })
    const run = fakeRunner({ listing: result(255, 'ssh: Could not resolve hostname laptop') })
    const outcome = await syncHost(host, { dataDir: data, run, now })
    expect(outcome).toEqual({
      name: 'laptop',
      status: 'failed',
      error: 'cannot reach host: ssh: Could not resolve hostname laptop',
      lastSuccess: '2026-10-03T12:00:00.000Z',
    })
    expect(run.calls).toHaveLength(1)
    const state = readState(hostDir(data, 'laptop'))
    expect(state.lastError).toBe(outcome.status === 'failed' ? outcome.error : '')
    expect(state.lastSuccess).toBe('2026-10-03T12:00:00.000Z')
    expect(state.lastAttempt).not.toBe('x')
  })

  it('reports rsync failures after a listing', async () => {
    const files = { '.claude/projects': ['a.jsonl'] }
    const failure = async (rsync: RunResult) => {
      const outcome = await syncHost(host, { dataDir: tempDir(), run: fakeRunner({ files, rsync: { '.claude/projects': rsync } }), now })
      return outcome.status === 'failed' ? outcome.error : outcome.status
    }
    expect(await failure(result(127, 'bash: rsync: command not found'))).toMatch(/^rsync not found on host/)
    // The listing found the path, so this is a file that vanished since, not a missing path.
    expect(await failure(result(23, 'rsync: link_stat "a.jsonl" failed: No such file or directory (2)'))).toBe(
      'rsync failed (exit 23): rsync: link_stat "a.jsonl" failed: No such file or directory (2)',
    )
  })

  it('prunes mirrored files older than the window plus a day, even when the host is unreachable', async () => {
    const data = tempDir()
    const at = now()
    const old = mirrored(data, '.claude/projects', '-p/old.jsonl', at, 32 * DAY)
    const edge = mirrored(data, '.claude/projects', '-p/edge.jsonl', at, 30.5 * DAY)
    const run = fakeRunner({ files: { '.claude/projects': [] } })
    expect(await syncHost(host, { dataDir: data, run, now, retentionMs: 30 * DAY })).toMatchObject({ status: 'ok', bytesPruned: 100 })
    expect(existsSync(old)).toBe(false)
    expect(existsSync(edge)).toBe(true)

    const older = mirrored(data, '.claude/projects', '-p/older.jsonl', at, 40 * DAY)
    const offline = fakeRunner({ listing: result(255, 'ssh: connect to host laptop port 22: Operation timed out') })
    expect(await syncHost(host, { dataDir: data, run: offline, now, retentionMs: 30 * DAY })).toMatchObject({ status: 'failed' })
    expect(existsSync(older)).toBe(false)
  })

  it('prunes slots left over from paths the host no longer has', async () => {
    const data = tempDir()
    const at = now()
    const old = mirrored(data, '/srv/old/projects', '-p/old.jsonl', at, 40 * DAY)
    const fresh = mirrored(data, '/srv/old/projects', '-p/fresh.jsonl', at, DAY)
    const run = fakeRunner({ files: { '.claude/projects': [] } })
    expect(await syncHost(host, { dataDir: data, run, now, retentionMs: 30 * DAY })).toMatchObject({ status: 'ok', bytesPruned: 100 })
    expect(existsSync(old)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
  })

  it('records its slots, and leaves alone dirs it did not create', async () => {
    const data = tempDir()
    const at = now()
    mirrored(data, '/srv/old/projects', '-p/a.jsonl', at, DAY)
    const run = fakeRunner({ files: { '.claude/projects': [] } })
    await syncHost(host, { dataDir: data, run, now, retentionMs: 30 * DAY })
    expect(readState(hostDir(data, 'laptop')).slots).toEqual(['_srv_old_projects', '_claude_projects', '_config_claude_projects'])

    const copy = join(hostDir(data, 'laptop'), '_srv_old_projects_backup', 'projects', '-p', 'old.jsonl')
    mkdirSync(dirname(copy), { recursive: true })
    writeFileSync(copy, 'x')
    utimesSync(copy, new Date(at.getTime() - 40 * DAY), new Date(at.getTime() - 40 * DAY))
    expect(await syncHost(host, { dataDir: data, run, now, retentionMs: 30 * DAY })).toMatchObject({ status: 'ok', bytesPruned: 0 })
    expect(existsSync(copy)).toBe(true)
    expect(readState(hostDir(data, 'laptop')).slots).toHaveLength(3)
  })

  it('keeps everything without a retention window', async () => {
    const data = tempDir()
    const old = mirrored(data, '.claude/projects', '-p/old.jsonl', now(), 400 * DAY)
    await syncHost(host, { dataDir: data, run: fakeRunner({ files: { '.claude/projects': [] } }), now })
    expect(existsSync(old)).toBe(true)
  })

  it('skips a host whose lock is held', async () => {
    const data = tempDir()
    acquireLock(hostDir(data, 'laptop'), now(), () => true, 1)
    const run = fakeRunner({})
    expect(await syncHost(host, { dataDir: data, run, now, isAlive: () => true })).toEqual({ name: 'laptop', status: 'locked' })
    expect(run.calls).toHaveLength(0)
  })

  it('records and prunes nothing when interrupted', async () => {
    const data = tempDir()
    const old = mirrored(data, '.claude/projects', '-p/old.jsonl', now(), 40 * DAY)
    let interrupted = false
    const run: Runner = async () => {
      interrupted = true
      return result(null, '', { signal: 'SIGINT' })
    }
    expect(await syncHost(host, { dataDir: data, run, now, retentionMs: DAY, interrupted: () => interrupted })).toEqual({
      name: 'laptop',
      status: 'interrupted',
    })
    expect(readState(hostDir(data, 'laptop')).lastAttempt).toBeNull()
    expect(existsSync(join(hostDir(data, 'laptop'), '.lock'))).toBe(false)
    expect(existsSync(old)).toBe(true)
  })
})

describe('syncHosts', () => {
  it('runs at most 4 hosts at once and returns outcomes in host order', async () => {
    const data = tempDir()
    let running = 0
    let peak = 0
    const run: Runner = async () => {
      peak = Math.max(peak, ++running)
      await new Promise((resolve) => setTimeout(resolve, 5))
      running--
      return ok
    }
    const hosts = Array.from({ length: 7 }, (_, i) => ({ name: `h${i}`, ssh: `h${i}`, paths: ['p'] }))
    const done: string[] = []
    const outcomes = await syncHosts(hosts, { dataDir: data, run, now: () => new Date() }, (outcome) => done.push(outcome.name))
    expect(peak).toBe(4)
    expect(outcomes.map((outcome) => outcome.name)).toEqual(hosts.map((host) => host.name))
    expect(done.sort()).toEqual(hosts.map((host) => host.name).sort())
    expect(outcomes.every((outcome) => outcome.status === 'ok')).toBe(true)
  })

  it('a failing host does not stop the others', async () => {
    const data = tempDir()
    const run: Runner = async (_command, args) => (args.includes('bad') ? result(255, 'Permission denied') : ok)
    const outcomes = await syncHosts(
      [
        { name: 'bad', ssh: 'bad', paths: ['bad'] },
        { name: 'good', ssh: 'good', paths: ['good'] },
      ],
      { dataDir: data, run, now: () => new Date() },
    )
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['failed', 'ok'])
  })
})

describe('output', () => {
  const now = new Date('2026-10-05T12:00:00Z')

  it('formats sizes', () => {
    expect(formatBytes(0)).toBe('+0 B')
    expect(formatBytes(34 * 1024)).toBe('+34 KB')
    expect(formatBytes(1536)).toBe('+1.5 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('+5.0 MB')
  })

  it('prints only failures off a TTY', () => {
    const opts = { tty: false, now, nameWidth: 6 }
    expect(formatOutcome({ name: 'laptop', status: 'ok', bytesAdded: 1, bytesPruned: 0, durationMs: 1400 }, opts)).toBeUndefined()
    expect(formatOutcome({ name: 'laptop', status: 'locked' }, opts)).toBeUndefined()
    expect(
      formatOutcome({ name: 'laptop', status: 'failed', error: 'cannot reach host', lastSuccess: '2026-10-03T12:00:00Z' }, opts),
    ).toBe('ccusage-sync: ✗ laptop  cannot reach host (using mirror from 2d ago)')
  })

  it('prints every host on a TTY', () => {
    const opts = { tty: true, now, nameWidth: 8 }
    expect(formatOutcome({ name: 'laptop', status: 'ok', bytesAdded: 34 * 1024, bytesPruned: 0, durationMs: 1400 }, opts)).toMatch(
      /laptop {4}\+34 KB {2}1\.4s$/,
    )
    expect(formatOutcome({ name: 'laptop', status: 'ok', bytesAdded: 0, bytesPruned: 5 * 1024 * 1024, durationMs: 1400 }, opts)).toContain(
      'pruned 5.0 MB',
    )
    expect(formatOutcome({ name: 'laptop', status: 'failed', error: 'x', lastSuccess: null }, opts)).toContain('x (no mirror yet)')
  })
})
