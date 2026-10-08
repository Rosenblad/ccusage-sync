// Writes test/fixtures/slim/projects: one line for every way ccusage reads a transcript. Run: node test/fixtures/slim/generate.mjs
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const root = join(import.meta.dirname, 'projects')
rmSync(root, { recursive: true, force: true })

const S1 = '33333333-3333-3333-3333-333333333333'
const S2 = '44444444-4444-4444-4444-444444444444'
const S3 = '55555555-5555-5555-5555-555555555555'
const S4 = '66666666-6666-6666-6666-666666666666'
const S5 = '77777777-7777-7777-7777-777777777777'
const S6 = '88888888-8888-8888-8888-888888888888'
const ALPHA = '-home-u-alpha'
const BETA = '-home-u-beta'
const VERSION = '2.0.31'
const SONNET = 'claude-sonnet-4-5-20250929'
const OPUS = 'claude-opus-4-6'
const HAIKU = 'claude-haiku-4-5-20251001'
const ADVISOR = 'claude-opus-4-20250514'

let n = 0
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`

function usage(input, output, cacheWrite = 0, cacheRead = 0, extra = {}) {
  return {
    input_tokens: input,
    cache_creation_input_tokens: cacheWrite,
    cache_read_input_tokens: cacheRead,
    cache_creation: { ephemeral_5m_input_tokens: cacheWrite, ephemeral_1h_input_tokens: 0 },
    output_tokens: output,
    service_tier: 'standard',
    ...extra,
  }
}

/** A Claude Code assistant line with the bookkeeping slimming drops. */
function assistant({ session, ts, id, req, model = SONNET, u, text = 'Here is the change.', extra = {}, cwd = '/home/u/alpha' }) {
  const line = {
    parentUuid: uuid(),
    isSidechain: false,
    userType: 'external',
    cwd,
    sessionId: session,
    version: VERSION,
    gitBranch: 'main',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model,
      content: [{ type: 'text', text }, { type: 'tool_use', id: `toolu_${id}`, name: 'Bash', input: { command: 'ls -la' } }],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: u,
    },
    requestId: req,
    type: 'assistant',
    uuid: uuid(),
    timestamp: ts,
    ...extra,
  }
  if (req === undefined) delete line.requestId
  return line
}

function user({ session, ts, text = 'Please refactor the parser and run the tests.', extra = {}, cwd = '/home/u/alpha' }) {
  return {
    parentUuid: uuid(),
    isSidechain: false,
    userType: 'external',
    cwd,
    sessionId: session,
    version: VERSION,
    gitBranch: 'main',
    type: 'user',
    message: { role: 'user', content: text },
    uuid: uuid(),
    timestamp: ts,
    ...extra,
  }
}

const files = new Map()
const add = (path, ...lines) => {
  const list = files.get(path) ?? []
  for (const line of lines) list.push(typeof line === 'string' ? line : JSON.stringify(line))
  files.set(path, list)
}
const epoch = (iso) => Math.floor(Date.parse(iso) / 1000)

// --- alpha / S1: the main session, one of every kind of line ---
const s1 = `${ALPHA}/${S1}.jsonl`
add(s1,
  { type: 'summary', summary: 'Fixture session', leafUuid: 'u0' },
  { type: 'file-history-snapshot', messageId: 'snap1', snapshot: { trackedFileBackups: {} }, isSnapshotUpdate: false },
  // The first line with a sessionId has no usage: ccusage's recorded_session_id still reads it.
  user({ session: S1, ts: '2026-09-24T08:59:00.000Z' }),
  // Plain assistant lines, with stop_sequence null (a null ccusage allows) and a 1-hour cache write.
  assistant({ session: S1, ts: '2026-09-24T09:00:00.000Z', id: 'msg_s1_01', req: 'req_s1_01', u: usage(10, 200, 3000, 1000) }),
  assistant({
    session: S1, ts: '2026-09-24T09:05:00.000Z', id: 'msg_s1_02', req: 'req_s1_02',
    u: { ...usage(12, 300, 5000, 4000), cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 4000 } },
  }),
  // A tool result whose toolUseResult carries a usage object: the marker is there, but it is no usage entry.
  user({
    session: S1, ts: '2026-09-24T09:06:00.000Z',
    extra: { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: 'done' }] }, toolUseResult: { status: 'completed', totalTokens: 999, usage: { input_tokens: 900, output_tokens: 99 } } },
  }),
  // Fast mode, then a copy without speed: the dedupe prefers the fast one.
  assistant({ session: S1, ts: '2026-09-25T10:00:00.000Z', id: 'msg_s1_fast', req: 'req_s1_fast', model: OPUS, u: usage(40, 400, 0, 2000, { speed: 'fast' }) }),
  assistant({ session: S1, ts: '2026-09-25T10:00:00.000Z', id: 'msg_s1_fast', req: 'req_s1_fast', model: OPUS, u: usage(40, 400, 0, 2000) }),
  assistant({ session: S1, ts: '2026-09-25T10:10:00.000Z', id: 'msg_s1_std', req: 'req_s1_std', model: OPUS, u: usage(41, 410, 0, 2100, { speed: 'standard' }) }),
  // Advisor usage in usage.iterations, with the iteration model null that ccusage allows.
  assistant({
    session: S1, ts: '2026-09-26T11:00:00.000Z', id: 'msg_s1_adv', req: 'req_s1_adv', extra: { advisorModel: ADVISOR },
    u: {
      ...usage(2, 491, 7853, 226584),
      iterations: [
        { type: 'message', model: null, input_tokens: 1, output_tokens: 45, cache_creation_input_tokens: 7192, cache_read_input_tokens: 109696 },
        { type: 'advisor_message', model: ADVISOR, input_tokens: 159419, output_tokens: 7805, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        { type: 'message', input_tokens: 1, output_tokens: 446, cache_creation_input_tokens: 661, cache_read_input_tokens: 116888 },
      ],
    },
  }),
  // costUSD, read in auto and display mode.
  assistant({ session: S1, ts: '2026-09-27T12:00:00.000Z', id: 'msg_s1_cost', req: 'req_s1_cost', u: usage(15, 150, 0, 500), extra: { costUSD: 0.4321 } }),
  assistant({ session: S1, ts: '2026-09-27T12:01:00.000Z', id: 'msg_s1_cost0', req: 'req_s1_cost0', model: HAIKU, u: usage(5, 50), extra: { costUSD: 0 } }),
  // A usage-limit error: blocks reads the reset time from the raw line text.
  assistant({
    session: S1, ts: '2026-09-28T13:00:00.000Z', id: 'msg_s1_limit', req: 'req_s1_limit', model: '<synthetic>', u: usage(0, 0),
    text: `Claude AI usage limit reached|${epoch('2026-09-28T15:00:00.000Z')}`, extra: { isApiErrorMessage: true, error: 'rate_limit' },
  }),
  assistant({ session: S1, ts: '2026-09-28T13:30:00.000Z', id: 'msg_s1_after', req: 'req_s1_after', u: usage(9, 90, 0, 900) }),
  // isApiErrorMessage false with the same text: nothing is read from it.
  assistant({
    session: S1, ts: '2026-09-28T13:40:00.000Z', id: 'msg_s1_nolimit', req: 'req_s1_nolimit', u: usage(3, 30),
    text: `Claude AI usage limit reached|${epoch('2026-09-28T20:00:00.000Z')}`, extra: { isApiErrorMessage: false },
  }),
  // A forbidden null deep in the content: ccusage skips the whole line.
  (() => {
    const line = assistant({ session: S1, ts: '2026-09-29T09:00:00.000Z', id: 'msg_s1_null', req: 'req_s1_null', u: usage(777, 777) })
    line.message.content[1].input = { id: null, command: 'ls' }
    return line
  })(),
  // A forbidden null inside usage.
  assistant({ session: S1, ts: '2026-09-29T09:10:00.000Z', id: 'msg_s1_null2', req: 'req_s1_null2', u: { ...usage(778, 778), cache_read_input_tokens: null } }),
  // Duplicate keys: counted without a null in the line, skipped with one.
  JSON.stringify(assistant({ session: S1, ts: '2026-09-29T09:20:00.000Z', id: 'msg_s1_dup', req: 'req_s1_dup', u: usage(11, 110) })).replace('"gitBranch":"main"', '"gitBranch":"main","gitBranch":"dev"').replace('"stop_sequence":null', '"stop_sequence":"x"'),
  JSON.stringify(assistant({ session: S1, ts: '2026-09-29T09:30:00.000Z', id: 'msg_s1_dupnull', req: 'req_s1_dupnull', u: usage(779, 779) })).replace('"gitBranch":"main"', '"gitBranch":"main","gitBranch":"dev"'),
  // Numbers serde reads differently from JSON.parse: ccusage rejects a float token count, so the line is skipped.
  JSON.stringify(assistant({ session: S1, ts: '2026-09-29T09:40:00.000Z', id: 'msg_s1_float', req: 'req_s1_float', u: usage(788, 788) })).replace('"input_tokens":788', '"input_tokens":788.0'),
  // Not compact: no marker at all (ccusage never parses it), and a marker only elsewhere (ccusage counts the line).
  JSON.stringify(assistant({ session: S1, ts: '2026-09-29T10:00:00.000Z', id: 'msg_s1_spaced', req: 'req_s1_spaced', u: usage(780, 780) }), null, 1).replace(/\n */g, ' '),
  JSON.stringify({ ...assistant({ session: S1, ts: '2026-09-29T10:10:00.000Z', id: 'msg_s1_mixed', req: 'req_s1_mixed', u: usage(13, 130) }), toolUseResult: { usage: { input_tokens: 1, output_tokens: 1 } } }).replace('"message":{', '"message": {'),
  // Rejected by ccusage's own checks, which slimming must not change.
  assistant({ session: S1, ts: '2026-09-29T11:00:00.000Z', id: 'msg_s1_semver', req: 'req_s1_semver', u: usage(781, 781), extra: { version: 'not-semver' } }),
  assistant({ session: S1, ts: '2026-09-29T11:01:00.000Z', id: 'msg_s1_noreq', req: '', u: usage(782, 782) }),
  assistant({ session: S1, ts: '2026-09-29T11:02:00.000Z', id: '', req: 'req_s1_noid', u: usage(783, 783) }),
  assistant({ session: S1, ts: '2026-09-29T11:03:00.000Z', id: 'msg_s1_nomodel', req: 'req_s1_nomodel', model: '', u: usage(784, 784) }),
  assistant({ session: S1, ts: 'yesterday', id: 'msg_s1_badts', req: 'req_s1_badts', u: usage(785, 785) }),
  // No requestId: the dedupe key falls back to session and timestamp.
  assistant({ session: S1, ts: '2026-09-30T08:00:00.000Z', id: 'msg_s1_gw', req: undefined, u: usage(14, 140) }),
  assistant({ session: S1, ts: '2026-09-30T08:01:00.000Z', id: 'msg_s1_gw', req: undefined, u: usage(15, 150) }),
  assistant({ session: S1, ts: '2026-09-30T08:01:00.000Z', id: 'msg_s1_gw', req: undefined, u: usage(15, 150) }),
  // Truncated JSON, nesting past serde's limit, a lone surrogate, CRLF, and an escape JSON.stringify writes differently.
  JSON.stringify(assistant({ session: S1, ts: '2026-09-30T09:00:00.000Z', id: 'msg_s1_trunc', req: 'req_s1_trunc', u: usage(786, 786) })).slice(0, -40),
  JSON.stringify(assistant({ session: S1, ts: '2026-09-30T09:10:00.000Z', id: 'msg_s1_deep', req: 'req_s1_deep', u: usage(16, 160) })).replace('"text":"Here is the change."', `"text":"Here is the change.","nested":${'['.repeat(130)}${']'.repeat(130)}`),
  JSON.stringify(assistant({ session: S1, ts: '2026-09-30T09:20:00.000Z', id: 'msg_s1_surrogate', req: 'req_s1_surrogate', u: usage(17, 170), text: '\ud800' })),
  `${JSON.stringify(assistant({ session: S1, ts: '2026-09-30T09:30:00.000Z', id: 'msg_s1_crlf', req: 'req_s1_crlf', u: usage(18, 180) }))}\r`,
  JSON.stringify(assistant({ session: S1, ts: '2026-09-30T09:40:00.000Z', id: 'msg_s1_escape', req: 'req_s1_escape', u: usage(19, 190), text: 'café' })).replace('café', 'caf\\u00e9'),
  // Agent progress lines: subagent usage nested in data.message. One duplicates a subagent file line.
  {
    parentUuid: uuid(), isSidechain: false, userType: 'external', cwd: '/home/u/alpha', sessionId: S1, version: VERSION, type: 'progress',
    data: {
      type: 'agent_progress', prompt: 'Explore the repo',
      message: {
        type: 'assistant', timestamp: '2026-10-01T10:00:00.000Z', requestId: 'req_s1_prog', costUSD: 0.0123, isSidechain: false, uuid: uuid(),
        message: { model: HAIKU, id: 'msg_s1_prog', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Looking around.' }], usage: usage(20, 2, 0, 0) },
      },
    },
    toolUseID: 'toolu_prog', parentToolUseID: 'toolu_task', uuid: uuid(), timestamp: '2026-10-01T10:00:00.001Z',
  },
  {
    parentUuid: uuid(), isSidechain: false, userType: 'external', cwd: '/home/u/alpha', sessionId: S1, version: VERSION, type: 'progress',
    data: {
      type: 'agent_progress',
      message: {
        type: 'assistant', timestamp: '2026-10-01T10:01:00.000Z', requestId: 'req_sub_1', uuid: uuid(),
        message: { model: HAIKU, id: 'msg_sub_1', type: 'message', role: 'assistant', content: [], usage: usage(21, 3, 0, 100) },
      },
    },
    uuid: uuid(), timestamp: '2026-10-01T10:01:00.001Z',
  },
  // Progress with advisor iterations (model null allowed there too) and with a forbidden null.
  {
    sessionId: S1, version: VERSION, type: 'progress',
    data: { message: { timestamp: '2026-10-01T10:02:00.000Z', requestId: 'req_s1_prog2', isSidechain: true, message: { model: HAIKU, id: 'msg_s1_prog2', content: [], usage: { ...usage(22, 4), iterations: [{ type: 'message', model: null, input_tokens: 22, output_tokens: 4 }] } } } },
    uuid: uuid(), timestamp: '2026-10-01T10:02:00.001Z',
  },
  {
    sessionId: S1, version: VERSION, type: 'progress',
    data: { message: { timestamp: '2026-10-01T10:03:00.000Z', requestId: 'req_s1_prog3', message: { model: HAIKU, id: 'msg_s1_prog3', content: [{ type: 'tool_use', id: null }], usage: usage(787, 787) } } },
    uuid: uuid(), timestamp: '2026-10-01T10:03:00.001Z',
  },
  // A progress copy of another session's line: only its requestId makes it the same response.
  {
    sessionId: S1, version: VERSION, type: 'progress',
    data: { message: { timestamp: '2026-10-01T12:01:00.000Z', requestId: 'req_s6_01', message: { model: SONNET, id: 'msg_s6_01', content: [], usage: usage(90, 900, 0, 9000) } } },
    uuid: uuid(), timestamp: '2026-10-01T12:01:00.001Z',
  },
  // A sidechain progress replay of a parent line with a new requestId: only isSidechain makes it a replay.
  {
    sessionId: S1, version: VERSION, type: 'progress',
    data: { message: { timestamp: '2026-10-02T16:00:00.000Z', requestId: 'req_prog_replay', isSidechain: true, message: { model: SONNET, id: 'msg_s1_late2', content: [], usage: usage(32, 320, 200, 2000) } } },
    uuid: uuid(), timestamp: '2026-10-02T16:00:00.001Z',
  },
  // Activity spread over the window, with gaps longer than a 5-hour block.
  ...[
    ['2026-10-02T06:00:00.000Z', 30, 300], ['2026-10-02T07:30:00.000Z', 31, 310], ['2026-10-02T16:00:00.000Z', 32, 320],
    ['2026-10-03T09:00:00.000Z', 33, 330], ['2026-10-04T23:30:00.000Z', 34, 340], ['2026-10-05T00:30:00.000Z', 35, 350],
  ].map(([ts, input, output], i) => assistant({ session: S1, ts, id: `msg_s1_late${i}`, req: `req_s1_late${i}`, u: usage(input, output, 100 * i, 1000 * i) })),
  // <synthetic> model: counted in tokens, never in models.
  assistant({ session: S1, ts: '2026-10-03T09:30:00.000Z', id: 'msg_s1_synth', req: 'req_s1_synth', model: '<synthetic>', u: usage(1, 1) }),
  // No cache fields at all: they default to 0.
  JSON.stringify(assistant({ session: S1, ts: '2026-10-03T09:40:00.000Z', id: 'msg_s1_min', req: 'req_s1_min', u: { input_tokens: 23, output_tokens: 230 } })),
)

// Subagent transcript of S1: sidechain lines, one also seen as a progress line above.
add(`${ALPHA}/${S1}/subagents/agent-a1.jsonl`,
  user({ session: S1, ts: '2026-10-01T09:59:00.000Z', extra: { isSidechain: true, agentId: 'a1' } }),
  assistant({ session: S1, ts: '2026-10-01T10:01:00.000Z', id: 'msg_sub_1', req: 'req_sub_1', model: HAIKU, u: usage(21, 3, 0, 100), extra: { isSidechain: true, agentId: 'a1', costUSD: 0.06 } }),
  assistant({ session: S1, ts: '2026-10-01T10:04:00.000Z', id: 'msg_sub_2', req: 'req_sub_2', model: HAIKU, u: usage(24, 5, 0, 200), extra: { isSidechain: true, agentId: 'a1' } }),
)
// A /btw sidechain replaying a parent message with a new request ID, and requestless replays.
add(`${ALPHA}/${S1}/subagents/agent-btw.jsonl`,
  assistant({ session: S1, ts: '2026-09-24T09:00:00.000Z', id: 'msg_s1_01', req: 'req_btw_01', u: usage(10, 200, 3000, 1000), extra: { isSidechain: true } }),
  assistant({ session: S1, ts: '2026-10-02T07:30:00.000Z', id: 'msg_s1_late1', req: 'req_btw_02', u: usage(31, 999), extra: { isSidechain: true } }),
  assistant({ session: S1, ts: '2026-09-30T08:05:00.000Z', id: 'msg_s1_gw', req: undefined, u: usage(15, 150), extra: { isSidechain: true } }),
)

// --- alpha / S2: a resumed session. Its first sessionId is S1's, and it repeats S1 lines. ---
add(`${ALPHA}/${S2}.jsonl`,
  user({ session: S1, ts: '2026-10-02T05:00:00.000Z' }),
  assistant({ session: S1, ts: '2026-10-02T06:00:00.000Z', id: 'msg_s1_late0', req: 'req_s1_late0', u: usage(30, 300) }),
  assistant({ session: S2, ts: '2026-10-02T08:00:00.000Z', id: 'msg_s2_01', req: 'req_s2_01', u: usage(50, 500, 0, 5000) }),
  assistant({ session: S2, ts: '2026-10-03T08:00:00.000Z', id: 'msg_s2_02', req: 'req_s2_02', model: OPUS, u: usage(51, 510, 0, 5100) }),
)

// --- alpha / S3 and S4: S3's file has an old mtime (set by the test) yet holds entries inside --since windows. Only its
// first sessionId line, a user line naming S4, ties it to S4's recent file, so ccusage keeps it. ---
add(`${ALPHA}/${S3}.jsonl`,
  { type: 'summary', summary: 'Linked by its first sessionId' },
  user({ session: S4, ts: '2026-10-02T09:00:00.000Z' }),
  assistant({ session: S3, ts: '2026-10-02T09:01:00.000Z', id: 'msg_s3_01', req: 'req_s3_01', u: usage(60, 600, 0, 6000) }),
  assistant({ session: S3, ts: '2026-10-03T09:01:00.000Z', id: 'msg_s3_02', req: 'req_s3_02', u: usage(61, 610, 0, 6100) }),
)
add(`${ALPHA}/${S4}.jsonl`,
  user({ session: S4, ts: '2026-10-04T09:00:00.000Z' }),
  assistant({ session: S4, ts: '2026-10-04T09:01:00.000Z', id: 'msg_s4_01', req: 'req_s4_01', u: usage(70, 700) }),
)
// S5: old and unlinked, so --since skips the file.
add(`${ALPHA}/${S5}.jsonl`,
  user({ session: S5, ts: '2026-09-20T09:00:00.000Z' }),
  assistant({ session: S5, ts: '2026-09-20T09:01:00.000Z', id: 'msg_s5_01', req: 'req_s5_01', u: usage(80, 800) }),
  assistant({ session: S5, ts: '2026-09-21T09:01:00.000Z', id: 'msg_s5_02', req: 'req_s5_02', model: OPUS, u: usage(81, 810, 0, 0, { speed: 'fast' }) }),
)

// --- beta / S6: another project. Its first sessionId line isn't compact JSON, it repeats an alpha line across projects,
// and it repeats test/fixtures/machine-a's first line across roots. ---
add(`${BETA}/${S6}.jsonl`,
  '{"type": "user", "sessionId": "88888888-8888-8888-8888-888888888888", "message": {"role": "user", "content": "hi"}}',
  user({ session: S6, ts: '2026-10-01T12:00:00.000Z', cwd: '/home/u/beta' }),
  assistant({ session: S6, ts: '2026-10-01T12:01:00.000Z', id: 'msg_s6_01', req: 'req_s6_01', cwd: '/home/u/beta', u: usage(90, 900, 0, 9000) }),
  assistant({ session: S6, ts: '2026-10-03T09:00:00.000Z', id: 'msg_s2_01', req: 'req_s2_01', cwd: '/home/u/beta', u: usage(50, 500, 0, 5000) }),
  '{"type":"assistant","timestamp":"2026-10-01T10:00:00.000Z","sessionId":"11111111-1111-1111-1111-111111111111","cwd":"/home/u/proj","isSidechain":false,"requestId":"req_a1","message":{"id":"msg_a1","model":"claude-sonnet-4-5","role":"assistant","content":[],"usage":{"input_tokens":10,"output_tokens":100,"cache_creation_input_tokens":1000,"cache_read_input_tokens":5000}}}',
  assistant({ session: S6, ts: '2026-10-05T18:00:00.000Z', id: 'msg_s6_02', req: 'req_s6_02', model: HAIKU, cwd: '/home/u/beta', u: usage(91, 910), extra: { costUSD: 0.0091 } }),
)
// Legacy flat subagent transcript.
add(`${BETA}/agent-legacy1.jsonl`,
  assistant({ session: S6, ts: '2026-10-01T12:05:00.000Z', id: 'msg_s6_sub', req: 'req_s6_sub', model: HAIKU, cwd: '/home/u/beta', u: usage(92, 920), extra: { isSidechain: true } }),
)

for (const [path, lines] of files) {
  const file = join(root, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${lines.join('\n')}\n`)
}
console.log(`wrote ${files.size} files, ${[...files.values()].flat().length} lines`)
