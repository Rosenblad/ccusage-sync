import { readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { completeLength, slimChunk, slimFileInPlace, slimLine } from '../src/slim.js'
import { tempDir } from './helpers.js'

const usage = '{"input_tokens":1,"output_tokens":2}'
const entry = (extra = '') =>
  `{"type":"assistant","timestamp":"2026-10-01T10:00:00.000Z","sessionId":"s1","version":"2.0.0",${extra}"message":{"id":"m","model":"claude-sonnet-4-5","role":"assistant","content":[{"type":"text","text":"hi"}],"usage":${usage}},"requestId":"r","uuid":"u"}`
const slimmed = '{"type":"assistant","timestamp":"2026-10-01T10:00:00.000Z","sessionId":"s1","version":"2.0.0","requestId":"r","message":{"id":"m","model":"claude-sonnet-4-5","usage":{"input_tokens":1,"output_tokens":2}}}'
const slim = (...lines: string[]) => slimChunk(Buffer.from(lines.map((line) => `${line}\n`).join('')), { sessionSettled: false }).toString()

describe('slimLine', () => {
  it('drops lines ccusage never parses', () => {
    expect(slimLine(Buffer.from('{"type":"user","sessionId":"s1","message":{"content":"hi"}}'))).toEqual({ kind: 'drop' })
    expect(slimLine(Buffer.from('{"toolUseResult":{"usage":{"input_tokens":1}},"message":{"role":"user"}}'))).toEqual({ kind: 'drop' })
  })

  it('cuts a usage line down to the fields ccusage reads', () => {
    expect(slimLine(Buffer.from(entry()))).toEqual({ kind: 'slim', line: slimmed })
  })

  it('keeps whole the lines a cut could change', () => {
    for (const line of [
      entry('"isApiErrorMessage":true,'),
      entry('"x":{"id":null},'),
      entry().replace('"uuid":"u"', '"uuid":"u","uuid":"v"'),
      entry().replace('"input_tokens":1', '"input_tokens":1.0'),
      entry().replace('"message":{', '"message": {'),
      entry('"x":"\\ud800",'),
      entry(`"x":${'['.repeat(70)}${']'.repeat(70)},`),
      `${entry()}\r`,
      entry().slice(0, -5),
      entry().replace('"message":{"id"', '"message":["oops"],"m":{"id"'),
    ]) {
      expect(slimLine(Buffer.from(line)), line.slice(0, 120)).toEqual({ kind: 'keep' })
    }
    expect(slimLine(Buffer.from([0xff, ...Buffer.from(entry())]))).toEqual({ kind: 'keep' })
  })

  it('allows a null model directly in usage.iterations', () => {
    const line = entry().replace(usage, '{"input_tokens":1,"output_tokens":2,"iterations":[{"type":"message","model":null,"input_tokens":1,"output_tokens":2}]}')
    expect(slimLine(Buffer.from(line)).kind).toBe('slim')
  })
})

describe('slimChunk', () => {
  it('turns the first sessionId line into {"sessionId":…} when it would be dropped', () => {
    expect(slim('{"type":"summary"}', '{"type":"user","sessionId":"s0"}', '{"type":"user","sessionId":"s2"}', entry())).toBe(
      `{"sessionId":"s0"}\n${slimmed}\n`,
    )
  })

  it('adds nothing when the first sessionId line is a usage line', () => {
    expect(slim(entry(), '{"type":"user","sessionId":"s0"}')).toBe(`${slimmed}\n`)
  })

  it('reads past a null sessionId, as ccusage does', () => {
    expect(slim('{"type":"user","sessionId":null}', '{"type":"user","sessionId":"s0"}')).toBe('{"sessionId":"s0"}\n')
  })

  it('keeps whole a sessionId line it cannot read with certainty, until one it can', () => {
    const odd = '{"type": "user", "sessionId": "s0"}'
    expect(slim(odd, '{"type":"user","sessionId":"s1"}', odd)).toBe(`${odd}\n{"sessionId":"s1"}\n`)
  })

  it('carries the session rule across chunks', () => {
    const state = { sessionSettled: false }
    expect(slimChunk(Buffer.from('{"type":"user","sessionId":"s0"}\n'), state).toString()).toBe('{"sessionId":"s0"}\n')
    expect(slimChunk(Buffer.from('{"type":"user","sessionId":"s9"}\n'), state).toString()).toBe('')
  })
})

describe('completeLength', () => {
  it('ends at the last newline', () => {
    expect(completeLength(Buffer.from('a\nb\nc'))).toBe(4)
    expect(completeLength(Buffer.from('abc'))).toBe(0)
    expect(completeLength(Buffer.from(''))).toBe(0)
  })
})

describe('slimFileInPlace', () => {
  it('slims complete lines, leaves out a partial last line, and keeps the modification time', () => {
    const file = join(tempDir(), 's.jsonl')
    const source = `${entry()}\n{"type":"user"}\n{"type":"assist`
    writeFileSync(file, source)
    const time = new Date('2026-10-01T10:00:00Z')
    utimesSync(file, time, time)
    expect(slimFileInPlace(file)).toEqual({ offset: source.lastIndexOf('\n') + 1, size: slimmed.length + 1, sessionSettled: true })
    expect(readFileSync(file, 'utf8')).toBe(`${slimmed}\n`)
    expect(statSync(file).mtimeMs).toBe(time.getTime())
  })
})
