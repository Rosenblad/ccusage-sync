/**
 * Equivalence tests: the pinned ccusage must print byte-identical reports for full transcripts and for the copies
 * src/slim.ts makes of them. test/fixtures/slim holds every kind of line ccusage reads in its own way (generate.mjs
 * there says what each one is for); the ablation tests show that each one matters, by removing something the slimmer
 * keeps and requiring some report to change.
 *
 * These run on every ccusage bump. If one fails, the new ccusage reads something the slimmer drops: keep it, add a
 * fixture line for it, and bump SLIM_FORMAT so existing mirrors are fetched again in full.
 */
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolveCcusage } from '../src/ccusage.js'
import { slotDir } from '../src/paths.js'
import { completeLength, type SlimState, slimChunk, slimFileInPlace } from '../src/slim.js'
import { syncHost } from '../src/sync.js'
import { localHost } from './helpers.js'

const FIXTURES = join(import.meta.dirname, 'fixtures', 'slim')
const MACHINE_A = join(import.meta.dirname, 'fixtures', 'machine-a')
const S1 = '33333333-3333-3333-3333-333333333333'
const LIVE = '99999999-9999-9999-9999-999999999999'
/** A file last written before its entries: only its first sessionId line keeps it inside a --since window. */
const LINKED = '-home-u-alpha/55555555-5555-5555-5555-555555555555.jsonl'

const ccusage = resolveCcusage()!

const REPORTS: string[][] = [
  ['daily'],
  ['daily', '--breakdown'],
  ['daily', '--instances'],
  ['daily', '--instances', '--breakdown'],
  ['daily', '--mode', 'calculate'],
  ['daily', '--mode', 'display'],
  ['daily', '--since', '20260925'],
  ['daily', '--since', '20261001', '--until', '20261005'],
  ['daily', '--since', '20261002'],
  ['daily', '--single-thread'],
  ['daily', '--project=-home-u-beta'],
  ['weekly'],
  ['weekly', '--breakdown'],
  ['monthly'],
  ['monthly', '--breakdown'],
  ['monthly', '--mode', 'display'],
  ['session'],
  ['session', '--breakdown'],
  ['session', '--since', '20260930'],
  ['session', '--mode', 'display'],
  ['session', '--id', S1],
  ['blocks'],
  ['blocks', '--breakdown'],
  ['blocks', '--since', '20261001'],
  ['blocks', '--mode', 'calculate'],
]
/** Every report as `ccusage claude <report>` and, where ccusage has it, as the all-agents `ccusage <report>`. */
const VARIANTS: string[][] = REPORTS.flatMap((report) => [
  ['claude', ...report],
  ...(report.includes('--instances') || report.some((arg) => arg.startsWith('--project')) || report[1] === '--id' ? [] : [report]),
])

let base: string
let home: string
let full: string
let slim: string
/** The mirror `ccusage-sync sync` builds with store "usage", over two syncs. */
let synced: string

/** Each file's mtime: just after its last entry, as Claude Code would leave it. */
function setMtimes(root: string): void {
  for (const file of transcripts(root)) {
    const rel = relative(join(root, 'projects'), file)
    const stamps = [...readFileSync(file, 'utf8').matchAll(/"timestamp":"([^"]+)"/g)].map((m) => Date.parse(m[1]!)).filter((t) => !Number.isNaN(t))
    const time = rel === LINKED ? new Date('2026-09-20T00:00:00.000Z') : new Date(Math.max(...stamps) + 60_000)
    utimesSync(file, time, time)
  }
}

function transcripts(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort()
}

/** A session active right now, so the statusline and the active block have something to show. */
function liveSession(): string {
  const now = Date.now()
  const line = (minutesAgo: number, i: number) =>
    JSON.stringify({
      parentUuid: null,
      isSidechain: false,
      cwd: '/home/u/beta',
      sessionId: LIVE,
      version: '2.0.31',
      message: {
        id: `msg_live_${i}`,
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-5-20250929',
        content: [{ type: 'text', text: 'live' }],
        usage: { input_tokens: 100 + i, output_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 20_000 },
      },
      requestId: `req_live_${i}`,
      type: 'assistant',
      uuid: `live-${i}`,
      timestamp: new Date(now - minutesAgo * 60_000).toISOString(),
    })
  return `${[150, 40, 5].map(line).join('\n')}\n`
}

function copy(from: string, name: string): string {
  const to = join(base, name)
  cpSync(from, to, { recursive: true, preserveTimestamps: true })
  return to
}

function run(args: string[], roots: string, input?: string) {
  const env = { PATH: process.env.PATH, HOME: home, TZ: 'UTC', NO_COLOR: '1', CLAUDE_CONFIG_DIR: roots }
  const result = spawnSync(ccusage.command, [...ccusage.args, ...args], { env, input, encoding: 'utf8' })
  return { code: result.status, stdout: result.stdout, stderr: result.stderr }
}

const jsonArgs = (variant: string[]) => [...variant, '--json', '--offline', '--timezone', 'UTC']

/** The report, which must succeed with JSON that holds data, so that two failures or two empty reports can't match. */
function report(variant: string[], roots: string): string {
  const result = run(jsonArgs(variant), roots)
  expect(result.code, `${variant.join(' ')}: ${result.stderr}`).toBe(0)
  const json = JSON.parse(result.stdout) as unknown
  expect(JSON.stringify(json), variant.join(' ')).toMatch(/"(inputTokens|totalTokens)":[1-9]/)
  return result.stdout
}

/**
 * The full report and the slimmed one. Reports that depend on the clock (active blocks, remaining time) could tick
 * between two runs, so the full report is taken again if they differ.
 */
function compare(variant: string[], fullRoots: string, slimRoots: string): { full: string; slim: string } {
  const before = report(variant, fullRoots)
  const slimmed = report(variant, slimRoots)
  if (slimmed === before) return { full: before, slim: slimmed }
  return { full: report(variant, fullRoots), slim: slimmed }
}

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'ccusage-sync-equivalence-'))
  home = join(base, 'home')
  mkdirSync(home)
  full = copy(FIXTURES, 'full')
  writeFileSync(join(full, 'projects', '-home-u-beta', `${LIVE}.jsonl`), liveSession())
  setMtimes(full)
  utimesSync(join(full, 'projects', '-home-u-beta', `${LIVE}.jsonl`), new Date(), new Date())
  slim = copy(full, 'slim')
  for (const file of transcripts(slim)) slimFileInPlace(file)
})

beforeAll(async () => {
  // The host first has the first half of every file, cut mid-line, then all of it.
  const remote = join(base, 'remote')
  const remoteProjects = join(remote, '.claude', 'projects')
  cpSync(join(full, 'projects'), remoteProjects, { recursive: true, preserveTimestamps: true })
  const finished = transcripts(remoteProjects).map((file) => ({ file, data: readFileSync(file), mtime: statSync(file).mtime }))
  for (const { file, data } of finished) writeFileSync(file, data.subarray(0, Math.floor(data.length / 2)))
  const data = join(base, 'data')
  const fake = localHost(remote)
  const deps = { dataDir: data, ...fake, now: () => new Date(), retentionMs: 3650 * 86_400_000, store: 'usage' as const }
  const host = { name: 'box', ssh: 'box', paths: ['.claude/projects'] }
  expect(await syncHost(host, deps)).toMatchObject({ status: 'ok' })
  for (const { file, data, mtime } of finished) {
    writeFileSync(file, data)
    utimesSync(file, mtime, mtime)
  }
  expect(await syncHost(host, deps)).toMatchObject({ status: 'ok' })
  synced = slotDir(data, 'box', '.claude/projects')
})

afterAll(() => {
  if (base) rmSync(base, { recursive: true, force: true })
})

describe('slimmed transcripts', () => {
  it('keep only what ccusage reads, with the same paths and modification times', () => {
    const files = (root: string) => transcripts(root).map((file) => relative(root, file))
    expect(files(slim)).toEqual(files(full))
    for (const file of files(full)) {
      expect(statSync(join(slim, file)).mtimeMs, file).toBe(statSync(join(full, file)).mtimeMs)
    }
    // The fixtures are mostly lines kept whole; an ordinary line loses its content and bookkeeping.
    const ordinary = readFileSync(join(slim, 'projects', '-home-u-alpha', `${S1}.jsonl`), 'utf8').split('\n').find((line) => line.includes('msg_s1_01'))
    expect(JSON.parse(ordinary!)).toEqual({
      type: 'assistant',
      timestamp: '2026-09-24T09:00:00.000Z',
      sessionId: S1,
      version: '2.0.31',
      requestId: 'req_s1_01',
      isSidechain: false,
      cwd: '/home/u/alpha',
      message: {
        id: 'msg_s1_01',
        model: 'claude-sonnet-4-5-20250929',
        usage: {
          input_tokens: 10,
          cache_creation_input_tokens: 3000,
          cache_read_input_tokens: 1000,
          cache_creation: { ephemeral_5m_input_tokens: 3000, ephemeral_1h_input_tokens: 0 },
          output_tokens: 200,
          service_tier: 'standard',
        },
      },
    })
  })

  it.each(VARIANTS.map((variant) => [variant.join(' '), variant]))('report identically: %s', (_, variant) => {
    const { full: expected, slim: actual } = compare(variant, full, slim)
    expect(actual).toBe(expected)
  })

  it.each(VARIANTS.map((variant) => [variant.join(' '), variant]))('report identically next to local logs: %s', (_, variant) => {
    const { full: expected, slim: actual } = compare(variant, `${MACHINE_A},${full}`, `${MACHINE_A},${slim}`)
    expect(actual).toBe(expected)
  })

  it.each(VARIANTS.map((variant) => [variant.join(' '), variant]))('report identically when synced: %s', (_, variant) => {
    const { full: expected, slim: actual } = compare(variant, full, synced)
    expect(actual).toBe(expected)
  })

  it('are the same whether slimmed in place or synced', () => {
    const files = (root: string) => transcripts(root).map((file) => [relative(root, file), readFileSync(file, 'utf8')])
    expect(files(join(synced, 'projects'))).toEqual(files(join(slim, 'projects')))
  })

  it('give the same statusline', () => {
    const input = JSON.stringify({
      session_id: LIVE,
      transcript_path: join(home, 'nonexistent.jsonl'),
      cwd: '/home/u/beta',
      model: { id: 'claude-sonnet-4-5-20250929', display_name: 'Sonnet 4.5' },
      workspace: { current_dir: '/home/u/beta', project_dir: '/home/u/beta' },
    })
    const statusline = (roots: string) => {
      const result = run(['statusline', '--offline'], roots, input)
      expect(result.code, result.stderr).toBe(0)
      expect(result.stdout).toMatch(/\$[0-9.]+ session .* block/)
      return result.stdout
    }
    const before = statusline(full)
    const actual = statusline(slim)
    expect([before, statusline(full)]).toContain(actual)
  })

  it('come out the same however the source is split into appended chunks', () => {
    for (const file of transcripts(full)) {
      const data = readFileSync(file)
      const whole = slimChunk(data, { sessionSettled: false })
      for (let cut = data.indexOf(0x0a) + 1; cut > 0 && cut < data.length; cut = data.indexOf(0x0a, cut) + 1) {
        const state: SlimState = { sessionSettled: false }
        const chunks = Buffer.concat([slimChunk(data.subarray(0, cut), state), slimChunk(data.subarray(cut), state)])
        expect(chunks.equals(whole), `${file} cut at ${cut}`).toBe(true)
      }
      expect(completeLength(data)).toBe(data.length)
    }
  })
})

// --- ablations ---

type Line = Record<string, any>

/** A copy of the slimmed mirror with `edit` applied to every compact JSON line (verbatim lines that aren't stay). */
function ablate(name: string, edit: (line: Line, raw: string) => Line | string | undefined): string {
  const root = copy(slim, `ablate-${name}`)
  for (const file of transcripts(root)) {
    const { atime, mtime } = statSync(file)
    const lines = readFileSync(file, 'utf8').split('\n').slice(0, -1)
    const edited = lines.flatMap((raw) => {
      let line: Line
      try {
        line = JSON.parse(raw) as Line
      } catch {
        return [raw]
      }
      if (JSON.stringify(line) !== raw) return [raw]
      const result = edit(line, raw)
      if (result === undefined) return []
      return [typeof result === 'string' ? result : JSON.stringify(result)]
    })
    writeFileSync(file, `${edited.map((line) => `${line}\n`).join('')}`)
    utimesSync(file, atime, mtime)
  }
  return root
}

/** The reference cut of the handoff, without its guards: what slimming a line that must stay whole would store. */
function naiveCut(line: Line): Line {
  const pick = (object: Line, keys: string[]) => Object.fromEntries(keys.filter((key) => key in object).map((key) => [key, object[key]]))
  const out: Line = pick(line, ['type', 'timestamp', 'sessionId', 'version', 'requestId', 'costUSD', 'isApiErrorMessage', 'isSidechain', 'cwd'])
  if (line.message) out.message = pick(line.message, ['id', 'model', 'usage'])
  if (line.data?.message?.message) {
    out.data = { message: { ...pick(line.data.message, ['timestamp', 'requestId', 'costUSD', 'isSidechain']), message: pick(line.data.message.message, ['id', 'model', 'usage']) } }
  }
  return out
}

/** A copy of the slimmed mirror where the lines with these message IDs are cut anyway, from the full source. */
function forceCut(name: string, ids: string[]): string {
  const root = copy(slim, `force-${name}`)
  for (const file of transcripts(root)) {
    const { atime, mtime } = statSync(file)
    const source = readFileSync(join(full, relative(root, file)), 'utf8').split('\n')
    const kept = readFileSync(file, 'utf8').split('\n')
    const cut = kept.map((line) => {
      const id = /"id":"(msg_[a-z0-9_]+)"/.exec(line)?.[1]
      if (!id || !ids.includes(id)) return line
      expect(source).toContain(line) // it was kept verbatim
      return JSON.stringify(naiveCut(JSON.parse(line) as Line))
    })
    writeFileSync(file, cut.join('\n'))
    utimesSync(file, atime, mtime)
  }
  return root
}

/** The variants whose report differs between the slimmed mirror and `root`. */
function changedBy(root: string): string[] {
  return VARIANTS.filter((variant) => run(jsonArgs(variant), root).stdout !== run(jsonArgs(variant), slim).stdout).map((variant) => variant.join(' '))
}

const without = (path: string[]) => (line: Line) => {
  let object = line
  for (const key of path.slice(0, -1)) {
    if (typeof object?.[key] !== 'object' || object[key] === null) return line
    object = object[key]
  }
  delete object[path.at(-1)!]
  return line
}

describe('ablation: each thing the slimmer keeps changes some report', () => {
  const fields: [string, (line: Line) => Line][] = [
    ['timestamp', without(['timestamp'])],
    ['sessionId', without(['sessionId'])],
    ['version', without(['version'])],
    ['requestId', without(['requestId'])],
    ['costUSD', without(['costUSD'])],
    ['isApiErrorMessage', without(['isApiErrorMessage'])],
    ['isSidechain', without(['isSidechain'])],
    ['message.id', without(['message', 'id'])],
    ['message.model', without(['message', 'model'])],
    ['message.usage.speed', without(['message', 'usage', 'speed'])],
    ['message.usage.cache_creation', without(['message', 'usage', 'cache_creation'])],
    ['message.usage.iterations', without(['message', 'usage', 'iterations'])],
    ['data (progress lines)', without(['data'])],
    ['data.message.timestamp', without(['data', 'message', 'timestamp'])],
    ['data.message.requestId', without(['data', 'message', 'requestId'])],
    ['data.message.costUSD', without(['data', 'message', 'costUSD'])],
    ['data.message.isSidechain', without(['data', 'message', 'isSidechain'])],
    ['data.message.message.id', without(['data', 'message', 'message', 'id'])],
    ['data.message.message.model', without(['data', 'message', 'message', 'model'])],
  ]

  it.each(fields)('%s', (name, edit) => {
    expect(changedBy(ablate(name, edit))).not.toEqual([])
  })

  it('the first sessionId line', () => {
    // The lines the slimmer adds, `{"sessionId":…}`, stand for dropped lines such as the one tying S3's file to S4.
    const root = ablate('first-session', (line) => (Object.keys(line).join() === 'sessionId' ? undefined : line))
    expect(changedBy(root)).toContain('claude daily --since 20261002')
  })

  it('modification times', () => {
    const root = copy(slim, 'ablate-mtime')
    for (const file of transcripts(root)) utimesSync(file, new Date('2026-09-01T00:00:00Z'), new Date('2026-09-01T00:00:00Z'))
    expect(changedBy(root)).not.toEqual([])
  })

  const verbatim: [string, string[]][] = [
    ['a forbidden null', ['msg_s1_null']],
    ['a forbidden null in a progress line', ['msg_s1_prog3']],
    ['duplicate keys', ['msg_s1_dupnull']],
    ['a number JSON.stringify rewrites', ['msg_s1_float']],
    ['nesting past serde_json\'s limit', ['msg_s1_deep']],
    ['a lone surrogate', ['msg_s1_surrogate']],
    ['the usage-limit message', ['msg_s1_limit']],
  ]

  it.each(verbatim)('keeping whole a line with %s', (name, ids) => {
    expect(changedBy(forceCut(name.replace(/\W+/g, '-'), ids))).not.toEqual([])
  })
})
