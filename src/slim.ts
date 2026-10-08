import { readFileSync, renameSync, statSync, utimesSync, writeFileSync } from 'node:fs'

/**
 * Slimming: a transcript cut down to what ccusage reads, so a mirror takes a tenth of the space. Every rule here
 * mirrors ccusage's Claude loader (rust/adapters/claude at the pinned tag); test/slim-equivalence.test.ts runs the
 * pinned ccusage on full and slimmed fixtures and requires byte-identical reports. When a line can't be cut with
 * certainty it is kept verbatim.
 *
 * Bump SLIM_FORMAT whenever the output for some input changes: mirrors in an older format are fetched again in full.
 */
export const SLIM_FORMAT = 1

/** ccusage parses only lines containing these exact bytes. */
const USAGE_MARK = Buffer.from('"usage":{')
/** ccusage's recorded_session_id reads the first line containing these bytes whose top-level sessionId is a string. */
const SESSION_MARK = Buffer.from('"sessionId"')
const TOP = ['type', 'timestamp', 'sessionId', 'version', 'requestId', 'costUSD', 'isApiErrorMessage', 'isSidechain', 'cwd']
const PROGRESS = ['timestamp', 'requestId', 'costUSD', 'isSidechain']
const MESSAGE = ['id', 'model', 'usage']
/** ccusage skips a line with any of these names null anywhere in it (has_unsupported_null_field_in_value). */
const NON_NULL = new Set([
  'id',
  'cwd',
  'model',
  'speed',
  'costUSD',
  'version',
  'sessionId',
  'requestId',
  'isApiErrorMessage',
  'cache_read_input_tokens',
  'cache_creation_input_tokens',
])
/**
 * serde_json refuses nesting deeper than 128 when ccusage's daily loader buffers a line, so it skips such a line while
 * other reports count it. Cutting the deep part would change that, so deep lines stay whole (with a safety margin).
 */
const MAX_DEPTH = 64
/**
 * A `\uD800`-`\uDFFF` escape left after a JSON round trip is a lone surrogate: the daily loader rejects the line, other
 * reports read it. Such lines stay whole.
 */
const SURROGATE_ESCAPE = /\\u[dD][89a-fA-F][0-9a-fA-F]{2}/

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type JsonObject = { [key: string]: Json }

function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function pick(object: JsonObject, keys: string[]): JsonObject {
  const out: JsonObject = {}
  for (const key of keys) if (Object.hasOwn(object, key)) out[key] = object[key]!
  return out
}

/** Whether `value` nests more than `levels` arrays and objects deep. */
function nestsDeeperThan(value: Json, levels: number): boolean {
  const children = Array.isArray(value) ? value : isObject(value) ? Object.values(value) : undefined
  if (!children) return false
  return levels === 0 || children.some((child) => nestsDeeperThan(child, levels - 1))
}

/** Port of ccusage's has_unsupported_null_field_in_value. `model` may be null directly in a usage.iterations element. */
function hasUnsupportedNull(root: JsonObject): boolean {
  const iterations = [
    (root.message as JsonObject | undefined)?.usage,
    ((root.data as JsonObject | undefined)?.message as JsonObject | undefined)?.message,
  ]
  const iterationArrays = [
    isObject(iterations[0]) ? iterations[0].iterations : undefined,
    isObject(iterations[1]) && isObject(iterations[1].usage) ? iterations[1].usage.iterations : undefined,
  ].filter(Array.isArray)
  const walk = (value: Json, allowModel: boolean): boolean => {
    if (Array.isArray(value)) {
      const isIterations = iterationArrays.includes(value)
      return value.some((item) => walk(item, isIterations))
    }
    if (isObject(value)) {
      return Object.entries(value).some(([key, item]) =>
        item === null && NON_NULL.has(key) ? !(allowModel && key === 'model') : walk(item, false),
      )
    }
    return false
  }
  return walk(root, false)
}

/** A line parsed with certainty: valid UTF-8, a JSON object, and exactly what JSON.stringify would write. */
function parseClean(line: Buffer): JsonObject | undefined {
  let text: string
  let value: Json
  try {
    text = utf8.decode(line)
    value = JSON.parse(text) as Json
    // The round trip rules out duplicate keys, whitespace, a trailing \r, escapes JSON.stringify writes differently,
    // and numbers it would print differently.
    if (!isObject(value) || JSON.stringify(value) !== text) return undefined
  } catch {
    return undefined
  }
  if (SURROGATE_ESCAPE.test(text) || nestsDeeperThan(value, MAX_DEPTH)) return undefined
  return value
}

function slimMessage(message: Json | undefined): JsonObject | undefined {
  if (!isObject(message)) return undefined
  if (Object.hasOwn(message, 'usage') && !isObject(message.usage!)) return undefined
  return pick(message, MESSAGE)
}

type LineResult = { kind: 'drop' } | { kind: 'keep' } | { kind: 'slim'; line: string }

/** What to store for one transcript line (without its newline). */
export function slimLine(line: Buffer): LineResult {
  if (line.indexOf(USAGE_MARK) === -1) return { kind: 'drop' }
  const object = parseClean(line)
  // Kept whole: the raw text is read (usage-limit reset), or a null makes ccusage skip the line.
  if (!object || object.isApiErrorMessage === true || hasUnsupportedNull(object)) return { kind: 'keep' }

  const out = pick(object, TOP)
  if (Object.hasOwn(object, 'message')) {
    const message = slimMessage(object.message)
    if (!message) return { kind: 'keep' }
    out.message = message
  }
  if (Object.hasOwn(object, 'data')) {
    const data = object.data
    if (!isObject(data)) return { kind: 'keep' }
    if (Object.hasOwn(data, 'message')) {
      const progress = data.message
      if (!isObject(progress)) return { kind: 'keep' }
      if (Object.hasOwn(progress, 'message')) {
        const message = slimMessage(progress.message)
        if (!message) return { kind: 'keep' }
        out.data = { message: { ...pick(progress, PROGRESS), message } }
      }
    }
  }
  const slimmed = JSON.stringify(out)
  return Buffer.from(slimmed).indexOf(USAGE_MARK) === -1 ? { kind: 'drop' } : { kind: 'slim', line: slimmed }
}

/** Per-file state carried between appended chunks. */
export interface SlimState {
  /** The line ccusage's recorded_session_id stops at has been passed. */
  sessionSettled: boolean
}

/**
 * Whether ccusage's recorded_session_id would stop at this line: 'yes' or 'no' when certain, 'unsure' when only
 * keeping the line verbatim reproduces its answer.
 */
function recordsSession(line: Buffer): { answer: 'yes'; sessionId: string } | { answer: 'no' | 'unsure' } {
  if (line.indexOf(SESSION_MARK) === -1) return { answer: 'no' }
  const object = parseClean(line)
  if (!object) return { answer: 'unsure' }
  if (typeof object.sessionId === 'string') return { answer: 'yes', sessionId: object.sessionId }
  // Absent or null: ccusage reads on. Another type is an error there, which reads on too.
  return { answer: 'no' }
}

/**
 * Slims complete lines (`data` ends with a newline, or is empty) and returns the bytes to append to the slimmed file.
 * The first line that records a session is reduced to `{"sessionId":…}` if it would otherwise be dropped, since
 * ccusage reads it for `--since` whatever its type.
 */
export function slimChunk(data: Buffer, state: SlimState): Buffer {
  const out: Buffer[] = []
  let start = 0
  while (start < data.length) {
    let end = data.indexOf(0x0a, start)
    if (end === -1) end = data.length
    const line = data.subarray(start, end)
    start = end + 1

    const result = slimLine(line)
    if (!state.sessionSettled) {
      const record = recordsSession(line)
      if (record.answer === 'unsure') {
        out.push(line, NEWLINE)
        continue
      }
      if (record.answer === 'yes') {
        state.sessionSettled = true
        // A kept or slimmed line keeps its sessionId, so it records the session itself.
        if (result.kind === 'drop') out.push(Buffer.from(`${JSON.stringify({ sessionId: record.sessionId })}\n`))
      }
    }
    if (result.kind === 'keep') out.push(line, NEWLINE)
    else if (result.kind === 'slim') out.push(Buffer.from(`${result.line}\n`))
  }
  return Buffer.concat(out)
}

const NEWLINE = Buffer.from('\n')

/** The length of the complete lines at the start of `data`: up to and including its last newline. */
export function completeLength(data: Buffer): number {
  return data.lastIndexOf(0x0a) + 1
}

/** Where a slimmed file stands relative to its source. */
export interface SlimProgress {
  /** Bytes of the source consumed: everything up to its last newline. */
  offset: number
  /** Size of the slimmed file. */
  size: number
  sessionSettled: boolean
}

/**
 * Slims a full transcript in place, keeping its modification time. A partial last line (Claude Code mid-write) is left
 * out: it is fetched from `offset` on the next sync.
 */
export function slimFileInPlace(file: string): SlimProgress {
  const { atime, mtime } = statSync(file)
  const data = readFileSync(file)
  const offset = completeLength(data)
  const state: SlimState = { sessionSettled: false }
  const slimmed = slimChunk(data.subarray(0, offset), state)
  writeFileSync(`${file}.tmp`, slimmed)
  utimesSync(`${file}.tmp`, atime, mtime)
  renameSync(`${file}.tmp`, file)
  return { offset, size: slimmed.length, sessionSettled: state.sessionSettled }
}
