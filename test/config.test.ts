import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ConfigError,
  DEFAULT_PATHS,
  emptyConfig,
  hostPaths,
  isLocalHost,
  loadConfig,
  normalizeRemotePath,
  parseDuration,
  reduceHostname,
  saveConfig,
  validateConfig,
} from '../src/config.js'
import { tempDir } from './helpers.js'

const valid = { version: 1, syncMaxAge: '5m', retention: 'claude', store: 'full', hosts: [{ name: 'laptop', ssh: 'me@laptop' }] }

describe('loadConfig / saveConfig', () => {
  it('treats a missing file as no hosts', () => {
    expect(loadConfig(join(tempDir(), 'nope', 'config.json'))).toEqual(emptyConfig())
  })

  it('round-trips through an atomic write', () => {
    const file = join(tempDir(), 'sub', 'config.json')
    const config = emptyConfig()
    config.hosts.push({ name: 'ws', ssh: 'ws' }, { name: 'laptop', ssh: 'laptop', paths: ['.claude/projects'] })
    saveConfig(file, config)
    expect(existsSync(`${file}.tmp`)).toBe(false)
    expect(loadConfig(file)).toEqual(config)

    config.hosts = config.hosts.filter((host) => host.name !== 'ws')
    saveConfig(file, config)
    expect(loadConfig(file).hosts.map((host) => host.name)).toEqual(['laptop'])
    expect(readFileSync(file, 'utf8').endsWith('\n')).toBe(true)
  })

  it('names the file on invalid JSON and on validation errors', () => {
    const file = join(tempDir(), 'config.json')
    writeFileSync(file, '{')
    expect(() => loadConfig(file)).toThrow(/config\.json: invalid JSON/)
    writeFileSync(file, JSON.stringify({ version: 2 }))
    expect(() => loadConfig(file)).toThrow(/config\.json: version/)
  })
})

describe('validateConfig', () => {
  it('accepts a valid config and fills defaults', () => {
    expect(validateConfig(valid)).toEqual(valid)
    expect(validateConfig({ version: 1 })).toEqual(emptyConfig())
  })

  const cases: [string, unknown, RegExp][] = [
    ['not an object', [], /JSON object/],
    ['wrong version', { version: 2 }, /^version/],
    ['missing version', { hosts: [] }, /^version/],
    ['bad syncMaxAge', { version: 1, syncMaxAge: '5 minutes' }, /^syncMaxAge/],
    ['numeric syncMaxAge', { version: 1, syncMaxAge: 300 }, /^syncMaxAge/],
    ['bad retention', { version: 1, retention: '30 days' }, /^retention/],
    ['numeric retention', { version: 1, retention: 30 }, /^retention/],
    ['bad store', { version: 1, store: 'slim' }, /^store: must be "full" or "usage"/],
    ['usage store kept forever', { version: 1, store: 'usage', retention: 'forever' }, /^store: "usage" cannot be used with retention "forever"/],
    ['hosts not an array', { version: 1, hosts: {} }, /^hosts:/],
    ['host not an object', { version: 1, hosts: ['x'] }, /^hosts\[0\]/],
    ['uppercase name', { version: 1, hosts: [{ name: 'Laptop', ssh: 'x' }] }, /^hosts\[0\]\.name/],
    ['name starting with dash', { version: 1, hosts: [{ name: '-x', ssh: 'x' }] }, /^hosts\[0\]\.name/],
    ['name with dot', { version: 1, hosts: [{ name: 'a.b', ssh: 'x' }] }, /^hosts\[0\]\.name/],
    ['reserved name', { version: 1, hosts: [{ name: 'local', ssh: 'x' }] }, /^hosts\[0\]\.name.*reserved/],
    ['duplicate name', { version: 1, hosts: [{ name: 'a', ssh: 'x' }, { name: 'a', ssh: 'y' }] }, /^hosts\[1\]\.name.*duplicate/],
    ['empty ssh', { version: 1, hosts: [{ name: 'a', ssh: ' ' }] }, /^hosts\[0\]\.ssh/],
    ['missing ssh', { version: 1, hosts: [{ name: 'a' }] }, /^hosts\[0\]\.ssh/],
    ['empty paths', { version: 1, hosts: [{ name: 'a', ssh: 'x', paths: [] }] }, /^hosts\[0\]\.paths/],
    ['non-string path', { version: 1, hosts: [{ name: 'a', ssh: 'x', paths: [1] }] }, /^hosts\[0\]\.paths\[0\]/],
    ['empty path', { version: 1, hosts: [{ name: 'a', ssh: 'x', paths: ['~/'] }] }, /^hosts\[0\]\.paths\[0\]/],
    ['unknown top-level field', { version: 1, sycnMaxAge: '1m' }, /^sycnMaxAge: unknown/],
    ['unknown host field', { version: 1, hosts: [{ name: 'a', ssh: 'x', path: [] }] }, /^hosts\[0\]\.path: unknown/],
  ]
  it.each(cases)('rejects %s', (_label, raw, message) => {
    expect(() => validateConfig(raw)).toThrow(ConfigError)
    expect(() => validateConfig(raw)).toThrow(message)
  })

  it('accepts every retention form', () => {
    for (const retention of ['claude', 'forever', '90d', '12h']) {
      expect(validateConfig({ version: 1, retention }).retention).toBe(retention)
    }
  })

  it('accepts both stores, full by default', () => {
    expect(validateConfig({ version: 1 }).store).toBe('full')
    expect(validateConfig({ version: 1, store: 'usage' }).store).toBe('usage')
    expect(validateConfig({ version: 1, store: 'usage', retention: '30d' }).store).toBe('usage')
  })

  it('normalizes paths: strips ~/ and keeps absolute paths', () => {
    const config = validateConfig({ version: 1, hosts: [{ name: 'a', ssh: 'x', paths: ['~/.claude/projects', '/srv/c/projects'] }] })
    expect(config.hosts[0]!.paths).toEqual(['.claude/projects', '/srv/c/projects'])
  })
})

describe('helpers', () => {
  it('defaults paths to ccusage roots', () => {
    expect(hostPaths({ name: 'a', ssh: 'a' })).toEqual(DEFAULT_PATHS)
    expect(DEFAULT_PATHS).toEqual(['.claude/projects', '.config/claude/projects'])
  })

  it('normalizes remote paths', () => {
    expect(normalizeRemotePath('~/.claude/projects')).toBe('.claude/projects')
    expect(normalizeRemotePath('~')).toBe('.')
    expect(normalizeRemotePath('/abs')).toBe('/abs')
  })

  it('parses durations', () => {
    expect(parseDuration('30s')).toBe(30_000)
    expect(parseDuration('5m')).toBe(300_000)
    expect(parseDuration('2h')).toBe(7_200_000)
    expect(parseDuration('1d')).toBe(86_400_000)
    expect(() => parseDuration('5')).toThrow(ConfigError)
  })
})

describe('local-host matching', () => {
  it('reduces ssh targets and hostnames', () => {
    expect(reduceHostname('me@Laptop.local')).toBe('laptop')
    expect(reduceHostname('laptop:2222')).toBe('laptop')
    expect(reduceHostname('ssh://me@laptop.example.com:22')).toBe('laptop')
    expect(reduceHostname('a@b@WS')).toBe('ws')
  })

  it('matches by name or by the ssh host part, case-insensitively', () => {
    expect(isLocalHost({ name: 'macbookpro', ssh: 'mbp' }, 'MacBookPro.lan')).toBe(true)
    expect(isLocalHost({ name: 'mbp', ssh: 'me@MacBookPro.local:22' }, 'macbookpro')).toBe(true)
    expect(isLocalHost({ name: 'ws', ssh: 'me@workstation.lan' }, 'MacBookPro.lan')).toBe(false)
  })

  it('does not resolve ssh aliases', () => {
    expect(isLocalHost({ name: 'mbp', ssh: 'mbp' }, 'MacBookPro')).toBe(false)
  })
})
