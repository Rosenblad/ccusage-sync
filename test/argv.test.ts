import { describe, expect, it } from 'vitest'
import { isStatusline, parseArgv, stripOurFlags, UsageError, validateHostNames } from '../src/argv.js'

describe('parseArgv', () => {
  it('handles --help and --version only at argv[0]', () => {
    expect(parseArgv(['--help'])).toEqual({ kind: 'help' })
    expect(parseArgv(['-h'])).toEqual({ kind: 'help' })
    expect(parseArgv(['--version'])).toEqual({ kind: 'version' })
    expect(parseArgv(['-v'])).toEqual({ kind: 'version' })
    expect(parseArgv(['claude', 'daily', '--help'])).toEqual({
      kind: 'forward',
      args: ['claude', 'daily', '--help'],
      noSync: false,
      hosts: undefined,
    })
    expect(parseArgv(['daily', '-v'])).toMatchObject({ kind: 'forward', args: ['daily', '-v'] })
  })

  it('detects management commands', () => {
    expect(parseArgv(['hosts', 'add', 'x', 'y', '--no-verify'])).toEqual({ kind: 'hosts', args: ['add', 'x', 'y', '--no-verify'] })
    expect(parseArgv(['sync', '--hosts', 'a,b'])).toEqual({ kind: 'sync', args: [], noSync: false, hosts: ['a', 'b'] })
  })

  it('forwards an empty argv (ccusage defaults to daily)', () => {
    expect(parseArgv([])).toEqual({ kind: 'forward', args: [], noSync: false, hosts: undefined })
  })
})

describe('stripOurFlags', () => {
  it('strips --no-sync from any position', () => {
    expect(stripOurFlags(['--no-sync', 'claude', 'daily'])).toMatchObject({ args: ['claude', 'daily'], noSync: true })
    expect(stripOurFlags(['claude', '--no-sync', 'daily'])).toMatchObject({ args: ['claude', 'daily'], noSync: true })
    expect(stripOurFlags(['claude', 'daily', '--no-sync'])).toMatchObject({ args: ['claude', 'daily'], noSync: true })
  })

  it('strips both forms of --hosts', () => {
    expect(stripOurFlags(['claude', '--hosts', 'a,b', 'daily'])).toMatchObject({ args: ['claude', 'daily'], hosts: ['a', 'b'] })
    expect(stripOurFlags(['claude', 'daily', '--hosts=local'])).toMatchObject({ args: ['claude', 'daily'], hosts: ['local'] })
  })

  it('merges repeated --hosts and drops duplicates', () => {
    expect(stripOurFlags(['--hosts', 'a', '--hosts=b,a']).hosts).toEqual(['a', 'b'])
  })

  it('rejects a missing or empty --hosts value', () => {
    expect(() => stripOurFlags(['daily', '--hosts'])).toThrow(UsageError)
    expect(() => stripOurFlags(['--hosts='])).toThrow(UsageError)
    expect(() => stripOurFlags(['--hosts', 'a,,b'])).toThrow(UsageError)
  })

  it('drops the first -- and forwards everything after it unchanged', () => {
    expect(stripOurFlags(['claude', 'daily', '--', '--no-sync', '--hosts', 'x', '--'])).toEqual({
      args: ['claude', 'daily', '--no-sync', '--hosts', 'x', '--'],
      noSync: false,
      hosts: undefined,
    })
    expect(stripOurFlags(['--no-sync', '--', '-p', '--hosts=x'])).toEqual({ args: ['-p', '--hosts=x'], noSync: true, hosts: undefined })
  })

  it('leaves ccusage options with values untouched', () => {
    const args = ['claude', 'daily', '-s', '20261001', '--since=20261001', '--jq', '.x', '-p', 'proj', '--json']
    expect(stripOurFlags(args)).toEqual({ args, noSync: false, hosts: undefined })
  })

  it('only matches our flags exactly', () => {
    const args = ['--no-sync-x', '--hostsx', '--host', 'a', '-hosts']
    expect(stripOurFlags(args)).toEqual({ args, noSync: false, hosts: undefined })
  })
})

describe('validateHostNames', () => {
  it('accepts configured names and local', () => {
    expect(() => validateHostNames(['local', 'laptop'], ['laptop', 'ws'])).not.toThrow()
  })

  it('rejects unknown names and lists the valid ones', () => {
    expect(() => validateHostNames(['lapto'], ['laptop', 'ws'])).toThrow(/lapto.*Valid names: local, laptop, ws/)
  })
})

describe('isStatusline', () => {
  it('matches statusline and claude statusline only', () => {
    expect(isStatusline(['statusline'])).toBe(true)
    expect(isStatusline(['claude', 'statusline', '--offline'])).toBe(true)
    expect(isStatusline(['claude', 'daily'])).toBe(false)
    expect(isStatusline(['daily', 'statusline'])).toBe(false)
    expect(isStatusline([])).toBe(false)
  })
})
