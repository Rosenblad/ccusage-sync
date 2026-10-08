import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, truncateSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FETCH_MARKER, FrameParser, parseStatListing, readIndex, statListScript } from '../src/fetch.js'
import { hostDir, slotDir } from '../src/paths.js'
import { SLIM_FORMAT, slimChunk } from '../src/slim.js'
import { createRunner, readState, rsyncArgs, type SyncDeps, syncHost, writeState } from '../src/sync.js'
import { localHost, tempDir } from './helpers.js'

const DAY = 86_400_000
const PATH = '.claude/projects'

const line = (i: number, extra = '') =>
  JSON.stringify({
    type: 'assistant',
    timestamp: `2026-10-01T10:${String(i % 60).padStart(2, '0')}:00.000Z`,
    sessionId: 's1',
    version: '2.0.0',
    message: { id: `m${i}`, model: 'claude-sonnet-4-5', role: 'assistant', content: [{ type: 'text', text: `reply ${i}${extra}` }], usage: { input_tokens: i, output_tokens: 1 } },
    requestId: `r${i}`,
    uuid: `u${i}`,
  })
const user = (session = 's1') => JSON.stringify({ type: 'user', sessionId: session, message: { role: 'user', content: 'hello' } })
const lines = (...items: string[]) => items.map((item) => `${item}\n`).join('')
const slimmed = (text: string) => slimChunk(Buffer.from(text.slice(0, text.lastIndexOf('\n') + 1)), { sessionSettled: false }).toString()

function setup(store: 'usage' | 'full' = 'usage') {
  const home = tempDir()
  const data = tempDir()
  const host = { name: 'box', ssh: 'me@box', paths: [PATH] }
  const fake = localHost(home)
  const remote = (rel: string) => join(home, PATH, rel)
  const local = (rel: string) => join(slotDir(data, 'box', PATH), 'projects', rel)
  const write = (rel: string, text: string, mtime = new Date(Date.now() - 60_000)) => {
    mkdirSync(dirname(remote(rel)), { recursive: true })
    writeFileSync(remote(rel), text)
    utimesSync(remote(rel), mtime, mtime)
  }
  const append = (rel: string, text: string) => {
    appendFileSync(remote(rel), text)
  }
  const deps: SyncDeps = { dataDir: data, run: fake.run, stream: fake.stream, now: () => new Date(), retentionMs: 30 * DAY, store }
  const sync = () => syncHost(host, deps)
  const index = () => readIndex(hostDir(data, 'box'))._claude_projects ?? {}
  return { home, data, host, deps, fake, remote, local, write, append, sync, index }
}

describe('statListScript', () => {
  it("lists each file's size and modification time with this system's stat", () => {
    const { home, write } = setup()
    const time = new Date('2026-10-01T10:00:00Z')
    write('-p/a.jsonl', 'abc\n', time)
    write("-p/odd name's/b.jsonl", 'x', time)
    write('-p/old.jsonl', 'old\n', new Date(Date.now() - 40 * DAY))
    const run = (retentionMs: number | undefined) => {
      const result = createRunner()('sh', ['-c', `cd '${home}' && sh -s`], statListScript([PATH, 'nope'], retentionMs))
      return result.then((r) => {
        expect(r.code, r.stderr).toBe(0)
        return parseStatListing(r.stdout, 2).map((files) => files?.sort((a, b) => a.path.localeCompare(b.path)))
      })
    }
    return Promise.all([run(undefined), run(30 * DAY)]).then(([all, recent]) => {
      expect(all).toEqual([
        [
          { path: '-p/a.jsonl', size: 4, mtimeMs: time.getTime() },
          { path: "-p/odd name's/b.jsonl", size: 1, mtimeMs: time.getTime() },
          expect.objectContaining({ path: '-p/old.jsonl', size: 4 }),
        ],
        undefined,
      ])
      // The old file is beyond the window, which ends 30 days ago (the file times above are in 2026-10).
      expect(recent![0]!.map((file) => file.path)).not.toContain('-p/old.jsonl')
    })
  })

  it('parses only well-formed lines for known paths', () => {
    expect(parseStatListing('motd\n0 12 1790000000 ./a.jsonl\n0 total\n5 1 1 ./b.jsonl\n1 missing\n', 2)).toEqual([
      [{ path: 'a.jsonl', size: 12, mtimeMs: 1_790_000_000_000 }],
      undefined,
    ])
  })
})

describe('FrameParser', () => {
  it('skips what comes before the marker and splits frames across any chunking', () => {
    const output = Buffer.from(`Welcome!\n${FETCH_MARKER}\n0 5\nab\ncd1 0\n2 3\nxyz`)
    for (let size = 1; size <= output.length; size++) {
      const frames: Record<number, string> = {}
      const parser = new FrameParser({
        start: (id) => (frames[id] = ''),
        data: (id, chunk) => (frames[id] += chunk.toString()),
        end: () => {},
      })
      for (let i = 0; i < output.length; i += size) parser.push(output.subarray(i, i + size))
      expect(frames).toEqual({ 0: 'ab\ncd', 1: '', 2: 'xyz' })
      expect(parser.complete).toBe(true)
    }
  })

  it('rejects output it does not understand', () => {
    const parser = new FrameParser({ start: () => {}, data: () => {}, end: () => {} })
    expect(() => parser.push(Buffer.from(`${FETCH_MARKER}\nnonsense\n`))).toThrow(/unexpected output/)
  })
})

describe('syncHost with store "usage"', () => {
  it('fetches and slims new files, keeping their modification times', async () => {
    const t = setup()
    const text = lines(user(), line(1), line(2)) + '{"type":"assist'
    const mtime = new Date('2026-10-07T10:00:00Z')
    t.write('-p/s1.jsonl', text, mtime)
    t.write('-p/s1/subagents/agent-a.jsonl', lines(line(3)), mtime)
    t.deps.now = () => new Date('2026-10-08T10:00:00Z')
    const outcome = await t.sync()
    expect(outcome).toMatchObject({ status: 'ok' })
    expect(readFileSync(t.local('-p/s1.jsonl'), 'utf8')).toBe(slimmed(text))
    expect(readFileSync(t.local('-p/s1/subagents/agent-a.jsonl'), 'utf8')).toBe(slimmed(lines(line(3))))
    expect(statSync(t.local('-p/s1.jsonl')).mtimeMs).toBe(mtime.getTime())
    expect(t.index()['-p/s1.jsonl']).toEqual({ offset: text.lastIndexOf('\n') + 1, size: slimmed(text).length, sessionSettled: true })
    expect(readState(hostDir(t.data, 'box')).store).toBe('usage')
    if (outcome.status === 'ok') expect(outcome.bytesAdded).toBe(slimmed(text).length + slimmed(lines(line(3))).length)
  })

  it('appends only new complete lines, and picks up a partial line once it is finished', async () => {
    const t = setup()
    const first = lines(user(), line(1))
    t.write('-p/s1.jsonl', first)
    await t.sync()
    t.append('-p/s1.jsonl', lines(line(2)) + line(3).slice(0, 50))
    await t.sync()
    expect(readFileSync(t.local('-p/s1.jsonl'), 'utf8')).toBe(slimmed(first + lines(line(2))))
    t.append('-p/s1.jsonl', `${line(3).slice(50)}\n`)
    await t.sync()
    const all = readFileSync(t.remote('-p/s1.jsonl'), 'utf8')
    expect(readFileSync(t.local('-p/s1.jsonl'), 'utf8')).toBe(slimmed(all))
    expect(t.index()['-p/s1.jsonl']!.offset).toBe(all.length)
  })

  it('fetches nothing for a file that has not grown, but follows its modification time', async () => {
    const t = setup()
    t.write('-p/s1.jsonl', lines(line(1)))
    await t.sync()
    const later = new Date(Date.now() - 1000 * 30)
    utimesSync(t.remote('-p/s1.jsonl'), later, later)
    t.fake.calls.length = 0
    await t.sync()
    expect(t.fake.calls).toEqual(['ssh']) // the listing only
    expect(Math.floor(statSync(t.local('-p/s1.jsonl')).mtimeMs / 1000)).toBe(Math.floor(later.getTime() / 1000))
  })

  it('fetches a file again in full when it shrank or was rewritten', async () => {
    const t = setup()
    t.write('-p/s1.jsonl', lines(line(1), line(2)))
    await t.sync()
    t.write('-p/s1.jsonl', lines(line(5)))
    await t.sync()
    expect(readFileSync(t.local('-p/s1.jsonl'), 'utf8')).toBe(slimmed(lines(line(5))))
    // Same length up to the old offset, but not ending in a newline there: not an append.
    const old = readFileSync(t.remote('-p/s1.jsonl'), 'utf8')
    const rewritten = lines(line(6, 'x'.repeat(old.length)))
    t.write('-p/s1.jsonl', rewritten)
    await t.sync()
    expect(readFileSync(t.local('-p/s1.jsonl'), 'utf8')).toBe(slimmed(rewritten))
  })

  it('fetches a file again in full when its local copy no longer matches the index', async () => {
    const t = setup()
    const text = lines(line(1), line(2))
    t.write('-p/s1.jsonl', text)
    await t.sync()
    appendFileSync(t.local('-p/s1.jsonl'), 'half-written')
    t.append('-p/s1.jsonl', lines(line(3)))
    await t.sync()
    expect(readFileSync(t.local('-p/s1.jsonl'), 'utf8')).toBe(slimmed(text + lines(line(3))))
    truncateSync(t.local('-p/s1.jsonl'), 3)
    await t.sync()
    expect(readFileSync(t.local('-p/s1.jsonl'), 'utf8')).toBe(slimmed(text + lines(line(3))))
  })

  it('slims a full mirror in place without fetching it again', async () => {
    const t = setup()
    const text = lines(user(), line(1), line(2))
    t.write('-p/s1.jsonl', text)
    mkdirSync(dirname(t.local('-p/s1.jsonl')), { recursive: true })
    writeFileSync(t.local('-p/s1.jsonl'), text)
    const mtime = statSync(t.remote('-p/s1.jsonl')).mtime
    utimesSync(t.local('-p/s1.jsonl'), mtime, mtime)
    writeState(hostDir(t.data, 'box'), { lastAttempt: null, lastSuccess: '2026-10-01T00:00:00Z', lastError: null })
    await t.sync()
    expect(t.fake.calls).toEqual(['ssh']) // the listing only
    expect(readFileSync(t.local('-p/s1.jsonl'), 'utf8')).toBe(slimmed(text))
    expect(t.index()['-p/s1.jsonl']).toEqual({ offset: text.length, size: slimmed(text).length, sessionSettled: true })
  })

  it('after a format change, fetches every mirrored file again, even one older than the window', async () => {
    const t = setup()
    t.write('-p/new.jsonl', lines(line(1)))
    t.write('-p/old.jsonl', lines(line(2)), new Date(Date.now() - 30 * DAY - 3_600_000))
    t.deps.retentionMs = 60 * DAY
    await t.sync()
    expect(existsSync(t.local('-p/old.jsonl'))).toBe(true)
    // An older format, whose files hold something else.
    const dir = hostDir(t.data, 'box')
    writeFileSync(t.local('-p/old.jsonl'), 'stale\n')
    writeFileSync(join(dir, 'index.json'), JSON.stringify({ format: SLIM_FORMAT - 1, slots: {} }))
    t.deps.retentionMs = 30 * DAY
    await t.sync()
    expect(readFileSync(t.local('-p/old.jsonl'), 'utf8')).toBe(slimmed(lines(line(2))))
    expect(Object.keys(t.index()).sort()).toEqual(['-p/new.jsonl', '-p/old.jsonl'])
  })

  it('keeps an untracked copy the host no longer has, and stops listing in full for it', async () => {
    const t = setup()
    t.write('-p/s1.jsonl', lines(line(1)))
    await t.sync()
    mkdirSync(dirname(t.local('-p/gone.jsonl')), { recursive: true })
    writeFileSync(t.local('-p/gone.jsonl'), lines(line(9)))
    await t.sync()
    expect(readFileSync(t.local('-p/gone.jsonl'), 'utf8')).toBe(lines(line(9)))
    expect(t.index()['-p/gone.jsonl']).toMatchObject({ offset: null })
  })

  it('refuses to slim without a retention window, and leaves a full mirror as it is', async () => {
    const t = setup()
    t.deps.retentionMs = undefined
    t.write('-p/s1.jsonl', lines(line(1)))
    mkdirSync(dirname(t.local('-p/s1.jsonl')), { recursive: true })
    writeFileSync(t.local('-p/s1.jsonl'), lines(line(1)))
    expect(await t.sync()).toMatchObject({ status: 'failed', error: expect.stringMatching(/retention window/) })
    expect(readFileSync(t.local('-p/s1.jsonl'), 'utf8')).toBe(lines(line(1)))
    expect(readState(hostDir(t.data, 'box')).store).toBeUndefined()
  })

  it('reports a host without logs, and a failed fetch', async () => {
    const t = setup()
    expect(await t.sync()).toMatchObject({ status: 'failed', error: expect.stringMatching(/no Claude Code logs on host/) })
    t.write('-p/s1.jsonl', lines(line(1)))
    t.deps.stream = async () => ({ code: 255, signal: null, stdout: '', stderr: 'ssh: connect to host box: Connection refused' })
    expect(await t.sync()).toMatchObject({ status: 'failed', error: 'cannot reach host: ssh: connect to host box: Connection refused' })
  })
})

describe('switching back to store "full"', () => {
  it('makes rsync ignore times until a sync succeeds', async () => {
    const t = setup('full')
    writeState(hostDir(t.data, 'box'), { lastAttempt: null, lastSuccess: null, lastError: null, store: 'usage' })
    t.write('-p/s1.jsonl', lines(line(1)))
    const rsyncCalls: string[][] = []
    const run = t.deps.run
    t.deps.run = (command, args, input) => {
      if (command !== 'rsync') return run(command, args, input)
      rsyncCalls.push(args)
      return Promise.resolve({ code: 0, signal: null, stdout: '', stderr: '' })
    }
    await t.sync()
    await t.sync()
    expect(rsyncCalls.map((args) => args.includes('--ignore-times'))).toEqual([true, false])
    expect(readState(hostDir(t.data, 'box')).store).toBeUndefined()
    expect(rsyncArgs('h', 'p', '/d', true)).toContain('--ignore-times')
  })
})
