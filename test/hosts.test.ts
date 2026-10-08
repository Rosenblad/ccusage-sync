import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { UsageError } from '../src/argv.js'
import { ConfigError, loadConfig, saveConfig } from '../src/config.js'
import { type HostsDeps, hostsCommand } from '../src/hosts.js'
import { hostDir } from '../src/paths.js'
import { type RunResult, writeState } from '../src/sync.js'
import { tempDir } from './helpers.js'

function setup(answer: RunResult = { code: 0, signal: null, stdout: '.claude/projects\n', stderr: '' }, confirmAnswer?: boolean) {
  const dir = tempDir()
  const out: string[] = []
  const err: string[] = []
  const calls: { command: string; args: string[] }[] = []
  const deps: HostsDeps = {
    configFile: join(dir, 'config', 'config.json'),
    dataDir: join(dir, 'data'),
    run: async (command, args) => {
      calls.push({ command, args })
      return answer
    },
    now: () => new Date('2026-10-05T12:00:00Z'),
    hostname: 'mbp',
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    confirm: confirmAnswer === undefined ? undefined : async () => confirmAnswer,
  }
  return { deps, calls, out: () => out.join(''), err: () => err.join('') }
}

describe('hosts add', () => {
  it('verifies over ssh and saves the host', async () => {
    const { deps, calls, out } = setup()
    expect(await hostsCommand(['add', 'laptop', 'me@laptop'], deps)).toBe(0)
    expect(calls).toEqual([
      {
        command: 'ssh',
        args: ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'me@laptop', 'ls -d .claude/projects .config/claude/projects'],
      },
    ])
    expect(loadConfig(deps.configFile).hosts).toEqual([{ name: 'laptop', ssh: 'me@laptop' }])
    expect(out()).toMatch(/Added laptop/)
  })

  it('stores --path values, normalized and deduplicated', async () => {
    const { deps, calls } = setup()
    await hostsCommand(['add', 'ws', 'ws', '--path', '~/.claude/projects', "--path=/srv/it's/projects", '--path', '.claude/projects'], deps)
    expect(loadConfig(deps.configFile).hosts[0]!.paths).toEqual(['.claude/projects', "/srv/it's/projects"])
    expect(calls[0]!.args.at(-1)).toBe(`ls -d .claude/projects '/srv/it'\\''s/projects'`)
  })

  it('fails on an unreachable host and saves nothing', async () => {
    const { deps, err } = setup({ code: 255, signal: null, stdout: '', stderr: 'ssh: Could not resolve hostname nope' })
    expect(await hostsCommand(['add', 'nope', 'nope'], deps)).toBe(1)
    expect(err()).toMatch(/cannot reach host/)
    expect(existsSync(deps.configFile)).toBe(false)
  })

  it('names an auth failure', async () => {
    const { deps, err } = setup({ code: 255, signal: null, stdout: '', stderr: 'me@h: Permission denied (publickey).' })
    expect(await hostsCommand(['add', 'h', 'me@h'], deps)).toBe(1)
    expect(err()).toMatch(/SSH auth failed/)
  })

  it('warns but saves when none of the paths exist', async () => {
    const { deps, err } = setup({ code: 1, signal: null, stdout: '', stderr: 'ls: .claude/projects: No such file or directory' })
    expect(await hostsCommand(['add', 'empty', 'empty'], deps)).toBe(0)
    expect(err()).toMatch(/none of these paths exist/)
    expect(loadConfig(deps.configFile).hosts).toHaveLength(1)
  })

  it('skips verification with --no-verify', async () => {
    const { deps, calls } = setup()
    expect(await hostsCommand(['add', 'x', 'x', '--no-verify'], deps)).toBe(0)
    expect(calls).toHaveLength(0)
  })

  it('rejects duplicate and invalid names', async () => {
    const { deps } = setup()
    await hostsCommand(['add', 'x', 'x'], deps)
    await expect(hostsCommand(['add', 'x', 'y'], deps)).rejects.toThrow(/already exists/)
    await expect(hostsCommand(['add', 'local', 'y'], deps)).rejects.toThrow(ConfigError)
    await expect(hostsCommand(['add', 'Bad', 'y'], deps)).rejects.toThrow(ConfigError)
    await expect(hostsCommand(['add', 'only-name'], deps)).rejects.toThrow(UsageError)
    await expect(hostsCommand(['add', 'a', 'b', '--bogus'], deps)).rejects.toThrow(/Unknown option/)
  })

  it('notes when the new host is this machine', async () => {
    const { deps, err } = setup()
    await hostsCommand(['add', 'mbp', 'me@mbp.local', '--no-verify'], deps)
    expect(err()).toMatch(/looks like this machine/)
  })
})

describe('hosts remove', () => {
  function withHost(confirmAnswer?: boolean) {
    const ctx = setup(undefined, confirmAnswer)
    saveConfig(ctx.deps.configFile, { version: 1, syncMaxAge: '5m', retention: 'claude', store: 'full', hosts: [{ name: 'laptop', ssh: 'laptop' }, { name: 'ws', ssh: 'ws' }] })
    const mirror = hostDir(ctx.deps.dataDir, 'laptop')
    const project = join(mirror, '_claude_projects', 'projects', 'p')
    mkdirSync(project, { recursive: true })
    writeFileSync(join(project, 'session.jsonl'), '')
    return { ...ctx, mirror }
  }

  it('keeps the mirror without a TTY and says how to purge', async () => {
    const { deps, mirror, out } = withHost()
    expect(await hostsCommand(['remove', 'laptop'], deps)).toBe(0)
    expect(loadConfig(deps.configFile).hosts.map((host) => host.name)).toEqual(['ws'])
    expect(existsSync(mirror)).toBe(true)
    expect(out()).toMatch(/--purge/)
    // Rerunning with --purge works although the config entry is gone.
    expect(await hostsCommand(['remove', 'laptop', '--purge'], deps)).toBe(0)
    expect(existsSync(mirror)).toBe(false)
  })

  it('asks on a TTY', async () => {
    const yes = withHost(true)
    await hostsCommand(['remove', 'laptop'], yes.deps)
    expect(existsSync(yes.mirror)).toBe(false)
    const no = withHost(false)
    await hostsCommand(['remove', 'laptop'], no.deps)
    expect(existsSync(no.mirror)).toBe(true)
  })

  it('deletes without asking with --purge', async () => {
    const { deps, mirror } = withHost(false)
    await hostsCommand(['remove', 'laptop', '--purge'], deps)
    expect(existsSync(mirror)).toBe(false)
  })

  it('deletes a mirror without logs without asking', async () => {
    const { deps, out } = setup(undefined, false)
    saveConfig(deps.configFile, { version: 1, syncMaxAge: '5m', retention: 'claude', store: 'full', hosts: [{ name: 'dead', ssh: 'dead' }] })
    const mirror = hostDir(deps.dataDir, 'dead')
    writeState(mirror, { lastAttempt: '2026-10-05T11:58:00Z', lastSuccess: null, lastError: 'cannot reach host' })
    expect(existsSync(mirror)).toBe(true)
    expect(await hostsCommand(['remove', 'dead'], deps)).toBe(0)
    expect(existsSync(mirror)).toBe(false)
    expect(out()).toBe('Removed dead.\n')
  })

  it('rejects an unknown host', async () => {
    const { deps } = withHost()
    await expect(hostsCommand(['remove', 'nope'], deps)).rejects.toThrow(/Unknown host 'nope'.*laptop, ws/)
  })

  it('rejects names that would point outside the mirror dir', async () => {
    const { deps } = withHost()
    const outside = join(deps.dataDir, '..', 'victim')
    mkdirSync(outside, { recursive: true })
    for (const name of ['../../victim', '..', '.', '']) {
      await expect(hostsCommand(['remove', name, '--purge'], deps)).rejects.toThrow(ConfigError)
    }
    expect(existsSync(outside)).toBe(true)
    expect(existsSync(hostDir(deps.dataDir, 'laptop'))).toBe(true)
  })
})

describe('hosts list', () => {
  it('shows each host with its last sync and error', async () => {
    const { deps, out } = setup()
    saveConfig(deps.configFile, {
      version: 1,
      syncMaxAge: '5m',
      retention: 'claude',
      store: 'full',
      hosts: [{ name: 'laptop', ssh: 'me@laptop' }, { name: 'ws', ssh: 'ws', paths: ['/srv/p'] }, { name: 'mbp', ssh: 'mbp' }, { name: 'new', ssh: 'new' }],
    })
    writeState(hostDir(deps.dataDir, 'laptop'), { lastAttempt: '2026-10-05T11:58:00Z', lastSuccess: '2026-10-05T11:58:00Z', lastError: null })
    writeState(hostDir(deps.dataDir, 'ws'), { lastAttempt: '2026-10-05T11:00:00Z', lastSuccess: '2026-10-03T12:00:00Z', lastError: 'cannot reach host' })
    expect(await hostsCommand(['list'], deps)).toBe(0)
    const lines = out().split('\n')
    expect(lines[0]).toMatch(/NAME\s+SSH\s+PATHS\s+LAST SYNC\s+STATUS/)
    expect(lines[1]).toMatch(/laptop\s+me@laptop\s+\.claude\/projects, \.config\/claude\/projects\s+2m ago\s+ok/)
    expect(lines[2]).toMatch(/ws\s+ws\s+\/srv\/p\s+2d ago\s+cannot reach host \(1h ago\)/)
    expect(lines[3]).toMatch(/mbp .*this machine, skipped/)
    expect(lines[4]).toMatch(/new .*never\s+not synced yet/)
  })

  it('explains how to add a host when there are none', async () => {
    const { deps, out } = setup()
    await hostsCommand(['list'], deps)
    expect(out()).toMatch(/No hosts configured/)
  })
})
