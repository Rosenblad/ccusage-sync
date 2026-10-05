/**
 * Contract tests against the pinned ccusage binary. They guard the ccusage behaviour this tool relies on:
 * several comma-separated roots in CLAUDE_CONFIG_DIR are merged, entries are deduplicated across roots,
 * missing roots are skipped, and our flags and commands are rejected by ccusage's own parser.
 * Rerun them whenever the ccusage pin is bumped.
 */
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import pkg from '../package.json' with { type: 'json' }
import { resolveCcusage } from '../src/ccusage.js'

const fixtures = join(import.meta.dirname, 'fixtures')
const A = join(fixtures, 'machine-a')
const B = join(fixtures, 'machine-b')

const ccusage = resolveCcusage()

function run(args: string[], claudeConfigDir?: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', TZ: 'UTC' }
  delete env.CLAUDE_CONFIG_DIR
  if (claudeConfigDir !== undefined) env.CLAUDE_CONFIG_DIR = claudeConfigDir
  const result = spawnSync(ccusage!.command, [...ccusage!.args, ...args], { env, encoding: 'utf8' })
  return { code: result.status, stdout: result.stdout, stderr: result.stderr }
}

interface Totals {
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  totalTokens: number
  totalCost: number
}

function totals(claudeConfigDir: string): Totals {
  const result = run(['claude', 'daily', '--json', '--offline'], claudeConfigDir)
  expect(result.code, result.stderr).toBe(0)
  return JSON.parse(result.stdout).totals as Totals
}

function expectSameTotals(actual: Totals, expected: Totals) {
  const { totalCost: actualCost, ...actualTokens } = actual
  const { totalCost: expectedCost, ...expectedTokens } = expected
  expect(actualTokens).toEqual(expectedTokens)
  expect(Math.abs(actualCost - expectedCost)).toBeLessThanOrEqual(1e-9 * Math.abs(expectedCost))
}

describe('ccusage contract', () => {
  it('5. resolves a binary that runs and prints the pinned version', () => {
    expect(ccusage).toBeDefined()
    const result = run(['--version'])
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe(`ccusage ${pkg.dependencies.ccusage}`)
  })

  it('fixtures have non-zero cost (model is in the offline pricing)', () => {
    expect(totals(A).totalCost).toBeGreaterThan(0)
    expect(totals(B).totalCost).toBeGreaterThan(0)
  })

  it('1. merges roots: a,b totals equal a + b', () => {
    const a = totals(A)
    const b = totals(B)
    const sum = Object.fromEntries(Object.keys(a).map((key) => [key, a[key as keyof Totals] + b[key as keyof Totals]])) as unknown as Totals
    expectSameTotals(totals(`${A},${B}`), sum)
  })

  it('2. dedups across roots: a,a equals a', () => {
    expectSameTotals(totals(`${A},${A}`), totals(A))
  })

  it('dedups within a root (fixture has one duplicate line)', () => {
    // Unique assistant lines in machine-a: input tokens 10 + 20 + 5 + 3; the duplicate of the first is not counted.
    expect(totals(A).inputTokens).toBe(38)
  })

  it('3. skips a missing root', () => {
    expectSameTotals(totals(`${A},${join(fixtures, 'does-not-exist')}`), totals(A))
  })

  it('accepts a projects/ dir itself as a root', () => {
    expectSameTotals(totals(join(A, 'projects')), totals(A))
  })

  it('4. our flags and commands are not ccusage flags or commands', () => {
    for (const flag of [['--no-sync'], ['--hosts', 'x'], ['--hosts=x']]) {
      const result = run(['claude', 'daily', ...flag], A)
      expect(result.code).toBe(2)
      expect(result.stderr).toMatch(/Unknown daily option/)
    }
    for (const command of ['hosts', 'sync']) {
      const result = run([command], A)
      expect(result.code).toBe(2)
      expect(result.stderr).toMatch(/Unknown command/)
    }
  })
})
