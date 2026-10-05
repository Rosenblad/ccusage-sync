import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { HostConfig } from '../src/config.js'
import { hostDir, slotDir } from '../src/paths.js'
import {
  acquireLock,
  classifySlot,
  formatBytes,
  formatOutcome,
  hostFailure,
  needsSync,
  type RunResult,
  readState,
  rsyncArgs,
  type Runner,
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
      '--prune-empty-dirs',
      '--include=*/',
      '--include=*.jsonl',
      '--exclude=*',
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
})

/** A runner that answers rsync calls from a script, keyed by remote path, and records each call. */
function fakeRunner(answers: Record<string, RunResult | ((dest: string) => RunResult)>): Runner & { calls: string[][] } {
  const calls: string[][] = []
  const run = (async (_command: string, args: string[]) => {
    calls.push(args)
    const remote = args.at(-2)!.split(':')[1]!.replace(/\/$/, '')
    const dest = args.at(-1)!
    const answer = answers[remote] ?? result(23, 'No such file or directory')
    return typeof answer === 'function' ? answer(dest) : answer
  }) as Runner & { calls: string[][] }
  run.calls = calls
  return run
}

/** Simulates rsync writing a file into the slot. */
function writes(bytes: number) {
  return (dest: string) => {
    mkdirSync(join(dest, 'p'), { recursive: true })
    writeFileSync(join(dest, 'p', 's.jsonl'), 'x'.repeat(bytes))
    return ok
  }
}

describe('syncHost', () => {
  const host: HostConfig = { name: 'laptop', ssh: 'me@laptop' }
  let clock = 0
  const now = () => new Date(Date.UTC(2026, 9, 5, 12) + (clock += 500))

  it('syncs each slot in order into its own dir and records success', async () => {
    const data = tempDir()
    const run = fakeRunner({ '.claude/projects': writes(2048) })
    const outcome = await syncHost(host, { dataDir: data, run, now })
    expect(outcome).toMatchObject({ name: 'laptop', status: 'ok', bytesAdded: 2048 })
    expect(run.calls.map((args) => args.at(-1))).toEqual([
      `${slotDir(data, 'laptop', '.claude/projects')}/projects/`,
      `${slotDir(data, 'laptop', '.config/claude/projects')}/projects/`,
    ])
    const state = readState(hostDir(data, 'laptop'))
    expect(state.lastError).toBeNull()
    expect(state.lastSuccess).not.toBeNull()
    expect(existsSync(join(hostDir(data, 'laptop'), '.lock'))).toBe(false)
  })

  it('records a failure and keeps the previous lastSuccess', async () => {
    const data = tempDir()
    writeState(hostDir(data, 'laptop'), { lastAttempt: 'x', lastSuccess: '2026-10-03T12:00:00.000Z', lastError: null })
    const run = fakeRunner({ '.claude/projects': result(255, 'ssh: Could not resolve hostname laptop') })
    const outcome = await syncHost(host, { dataDir: data, run, now })
    expect(outcome).toEqual({
      name: 'laptop',
      status: 'failed',
      error: 'cannot reach host: ssh: Could not resolve hostname laptop',
      lastSuccess: '2026-10-03T12:00:00.000Z',
    })
    // An unreachable host is not retried for its other slots.
    expect(run.calls).toHaveLength(1)
    const state = readState(hostDir(data, 'laptop'))
    expect(state.lastError).toBe(outcome.status === 'failed' ? outcome.error : '')
    expect(state.lastSuccess).toBe('2026-10-03T12:00:00.000Z')
    expect(state.lastAttempt).not.toBe('x')
  })

  it('skips a host whose lock is held', async () => {
    const data = tempDir()
    acquireLock(hostDir(data, 'laptop'), now(), () => true, 1)
    const run = fakeRunner({})
    expect(await syncHost(host, { dataDir: data, run, now, isAlive: () => true })).toEqual({ name: 'laptop', status: 'locked' })
    expect(run.calls).toHaveLength(0)
  })

  it('records nothing when interrupted', async () => {
    const data = tempDir()
    let interrupted = false
    const run: Runner = async () => {
      interrupted = true
      return result(null, '', { signal: 'SIGINT' })
    }
    expect(await syncHost(host, { dataDir: data, run, now, interrupted: () => interrupted })).toEqual({ name: 'laptop', status: 'interrupted' })
    expect(existsSync(join(hostDir(data, 'laptop'), 'state.json'))).toBe(false)
    expect(existsSync(join(hostDir(data, 'laptop'), '.lock'))).toBe(false)
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
    const run = fakeRunner({ good: ok, bad: result(255, 'Permission denied') })
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
    expect(formatOutcome({ name: 'laptop', status: 'ok', bytesAdded: 1, durationMs: 1400 }, opts)).toBeUndefined()
    expect(formatOutcome({ name: 'laptop', status: 'locked' }, opts)).toBeUndefined()
    expect(
      formatOutcome({ name: 'laptop', status: 'failed', error: 'cannot reach host', lastSuccess: '2026-10-03T12:00:00Z' }, opts),
    ).toBe('ccusage-sync: ✗ laptop  cannot reach host (using mirror from 2d ago)')
  })

  it('prints every host on a TTY', () => {
    const opts = { tty: true, now, nameWidth: 8 }
    expect(formatOutcome({ name: 'laptop', status: 'ok', bytesAdded: 34 * 1024, durationMs: 1400 }, opts)).toContain('laptop    +34 KB  1.4s')
    expect(formatOutcome({ name: 'laptop', status: 'failed', error: 'x', lastSuccess: null }, opts)).toContain('x (no mirror yet)')
  })
})
