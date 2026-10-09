import { EventEmitter } from 'node:events'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { emptyConfig } from '../src/config.js'
import { buildRoots, mirrorRoots, runCcusage, selectSources } from '../src/forward.js'
import { tempDir } from './helpers.js'

describe('selectSources', () => {
  const config = { ...emptyConfig(), hosts: [{ name: 'ws', ssh: 'me@workstation' }, { name: 'laptop', ssh: 'laptop' }] }

  it('selects local and every host by default', () => {
    const selection = selectSources(config, undefined, 'mbp')
    expect(selection.includeLocal).toBe(true)
    expect(selection.hosts.map((host) => host.name)).toEqual(['ws', 'laptop'])
    expect(selection.names).toEqual(['local', 'ws', 'laptop'])
  })

  it('applies --hosts, which can exclude local', () => {
    const selection = selectSources(config, ['laptop'], 'mbp')
    expect(selection.includeLocal).toBe(false)
    expect(selection.hosts.map((host) => host.name)).toEqual(['laptop'])
    expect(selectSources(config, ['local'], 'mbp')).toMatchObject({ includeLocal: true, hosts: [] })
  })

  it('reads a host that is this machine locally instead of syncing it', () => {
    const selection = selectSources(config, undefined, 'Workstation.lan')
    expect(selection.hosts.map((host) => host.name)).toEqual(['laptop'])
    expect(selection.skipped.map((host) => host.name)).toEqual(['ws'])
    expect(selectSources(config, ['ws'], 'workstation')).toMatchObject({ includeLocal: true, hosts: [] })
  })
})

describe('buildRoots', () => {
  it('keeps only roots with projects/, local roots first, without duplicates', () => {
    const exists = (root: string) => !root.includes('missing')
    expect(buildRoots(['/l1', '/missing-l', '/l2'], ['/m1', '/missing-m', '/l1'], exists)).toEqual(['/l1', '/l2', '/m1'])
  })

  it('returns nothing when no root has logs', () => {
    expect(buildRoots(['/a'], ['/b'], () => false)).toEqual([])
  })

  it('rejects a root containing a comma', () => {
    expect(() => buildRoots(['/a,b'], [], () => true)).toThrow(/comma/)
  })

  it('checks the filesystem by default', () => {
    const dir = tempDir()
    mkdirSync(join(dir, 'real', 'projects'), { recursive: true })
    expect(buildRoots([join(dir, 'real'), join(dir, 'nope')], [])).toEqual([join(dir, 'real')])
  })

  it('lists one mirror root per host slot', () => {
    expect(mirrorRoots('/d', [{ name: 'a', ssh: 'a' }, { name: 'b', ssh: 'b', paths: ['/srv/p'] }])).toEqual([
      '/d/hosts/a/_claude_projects',
      '/d/hosts/a/_config_claude_projects',
      '/d/hosts/b/_srv_p',
    ])
  })

  it('also lists slots left over from paths a host no longer has', () => {
    const dir = tempDir()
    for (const slot of ['_srv_p', '_old', '_claude_projects']) mkdirSync(join(dir, 'hosts', 'b', slot, 'projects'), { recursive: true })
    mkdirSync(join(dir, 'hosts', 'b', '_no_projects_dir'), { recursive: true })
    expect(mirrorRoots(dir, [{ name: 'b', ssh: 'b', paths: ['/srv/p'] }])).toEqual([
      join(dir, 'hosts/b/_srv_p'),
      join(dir, 'hosts/b/_claude_projects'),
      join(dir, 'hosts/b/_old'),
    ])
  })
})

/** A fake child process plus a spawn that returns it and records its arguments. */
function fakeSpawn() {
  const child = Object.assign(new EventEmitter(), { killed: [] as string[], kill(signal: string) { child.killed.push(signal); return true } })
  const calls: { command: string; args: string[]; options: { env?: Record<string, string | undefined>; stdio?: unknown } }[] = []
  const spawn = ((command: string, args: string[], options: never) => {
    calls.push({ command, args, options })
    return child
  }) as never
  return { child, calls, spawn }
}

describe('runCcusage', () => {
  it('forwards argv exactly, inherits stdio and sets the env', async () => {
    const { child, calls, spawn } = fakeSpawn()
    const done = runCcusage({ command: '/bin/ccusage', args: [] }, ['claude', 'daily', '--json'], { CLAUDE_CONFIG_DIR: '/a,/b' }, { spawn, signals: new EventEmitter() as never })
    child.emit('exit', 0, null)
    expect(await done).toBe(0)
    expect(calls).toEqual([{ command: '/bin/ccusage', args: ['claude', 'daily', '--json'], options: { stdio: 'inherit', env: { CLAUDE_CONFIG_DIR: '/a,/b' } } }])
  })

  it('prefixes the launcher args when falling back to node', async () => {
    const { child, calls, spawn } = fakeSpawn()
    const done = runCcusage({ command: 'node', args: ['/x/cli.js'] }, ['daily'], {}, { spawn, signals: new EventEmitter() as never })
    child.emit('exit', 0, null)
    await done
    expect(calls[0]!.args).toEqual(['/x/cli.js', 'daily'])
  })

  it("propagates the child's exit code", async () => {
    const { child, spawn } = fakeSpawn()
    const done = runCcusage({ command: 'c', args: [] }, [], {}, { spawn, signals: new EventEmitter() as never })
    child.emit('exit', 2, null)
    expect(await done).toBe(2)
  })

  it('passes signals on and exits 128 + signal number', async () => {
    const { child, spawn } = fakeSpawn()
    const signals = new EventEmitter()
    const done = runCcusage({ command: 'c', args: [] }, [], {}, { spawn, signals: signals as never })
    signals.emit('SIGINT')
    signals.emit('SIGTERM')
    expect(child.killed).toEqual(['SIGINT', 'SIGTERM'])
    child.emit('exit', null, 'SIGINT')
    expect(await done).toBe(130)
    expect(signals.listenerCount('SIGINT')).toBe(0)
  })

  it('reports a spawn failure', async () => {
    const { child, spawn } = fakeSpawn()
    const errors: string[] = []
    const done = runCcusage({ command: 'c', args: [] }, [], {}, { spawn, signals: new EventEmitter() as never, stderr: (text) => errors.push(text) })
    child.emit('error', new Error('spawn c EACCES'))
    expect(await done).toBe(1)
    expect(errors[0]).toMatch(/EACCES/)
  })
})
