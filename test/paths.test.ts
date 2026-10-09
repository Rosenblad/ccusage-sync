import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { configFile, dataDir, distinctSlots, hasProjects, hostSlots, leftoverSlots, localRoots, scanSlots, slotDir, slotName } from '../src/paths.js'
import { tempDir } from './helpers.js'

const home = '/home/u'

describe('XDG dirs', () => {
  it('defaults under the home dir', () => {
    expect(configFile({ env: {}, home })).toBe('/home/u/.config/ccusage-sync/config.json')
    expect(dataDir({ env: {}, home })).toBe('/home/u/.local/share/ccusage-sync')
  })

  it('honours absolute XDG vars and ignores relative ones', () => {
    const env = { XDG_CONFIG_HOME: '/cfg', XDG_DATA_HOME: '/data' }
    expect(configFile({ env, home })).toBe('/cfg/ccusage-sync/config.json')
    expect(dataDir({ env, home })).toBe('/data/ccusage-sync')
    expect(dataDir({ env: { XDG_DATA_HOME: 'rel' }, home })).toBe('/home/u/.local/share/ccusage-sync')
  })
})

describe('localRoots', () => {
  it("defaults to ccusage's two roots", () => {
    expect(localRoots({ env: {}, home })).toEqual(['/home/u/.config/claude', '/home/u/.claude'])
  })

  it('follows $XDG_CONFIG_HOME', () => {
    expect(localRoots({ env: { XDG_CONFIG_HOME: '/x' }, home })).toEqual(['/x/claude', '/home/u/.claude'])
  })

  it('uses $CLAUDE_CONFIG_DIR entries instead of the defaults', () => {
    expect(localRoots({ env: { CLAUDE_CONFIG_DIR: '/a, /b/projects,,' }, home })).toEqual(['/a', '/b/projects'])
  })

  it('treats an empty $CLAUDE_CONFIG_DIR as unset', () => {
    expect(localRoots({ env: { CLAUDE_CONFIG_DIR: ' ' }, home })).toEqual(['/home/u/.config/claude', '/home/u/.claude'])
  })
})

describe('slots', () => {
  it('replaces every non-alphanumeric character with _', () => {
    expect(slotName('.claude/projects')).toBe('_claude_projects')
    expect(slotName('.config/claude/projects')).toBe('_config_claude_projects')
    expect(slotName('/srv/claude-data/projects')).toBe('_srv_claude_data_projects')
  })

  it('places slots under the host dir', () => {
    expect(slotDir('/d', 'laptop', '.claude/projects')).toBe('/d/hosts/laptop/_claude_projects')
  })

  it('finds slots on disk: dirs holding projects/, named as slotName names them', () => {
    const dir = tempDir()
    for (const slot of ['_b', '_a', '_a.bak', 'old,2025', '_a copy']) mkdirSync(join(dir, slot, 'projects'), { recursive: true })
    mkdirSync(join(dir, 'projects')) // a slot named projects, but without projects/ inside
    writeFileSync(join(dir, 'state.json'), '{}')
    expect(scanSlots(dir)).toEqual(['_a', '_b'])
    expect(scanSlots(join(dir, 'missing'))).toEqual([])
  })

  it('finds known slots left over from paths no longer configured, if they still hold projects/', () => {
    const dir = tempDir()
    for (const slot of ['_b', '_a', '_current', '_unknown']) mkdirSync(join(dir, slot, 'projects'), { recursive: true })
    const known = ['_current', '_b', '_a', '_deleted']
    expect(leftoverSlots(dir, known, ['/current'])).toEqual(['_a', '_b'])
    expect(hostSlots(dir, known, ['/new', '/current', '/current'])).toEqual(['_new', '_current', '_a', '_b'])
  })

  it('counts slots that reach the same dir once, keeping the first name', () => {
    // As `_Claude_projects` and `_claude_projects` are on a case-insensitive filesystem.
    const dir = tempDir()
    for (const slot of ['_a', '_b']) mkdirSync(join(dir, slot, 'projects'), { recursive: true })
    symlinkSync('_a', join(dir, '_current'))
    symlinkSync('_b', join(dir, '_b_alias'))
    const known = ['_a', '_b', '_b_alias']
    expect(distinctSlots(dir, ['_current', '_new', '_a', '_new', '_b'])).toEqual(['_current', '_new', '_b'])
    expect(leftoverSlots(dir, known, ['/current'])).toEqual(['_b'])
    expect(hostSlots(dir, known, ['/current'])).toEqual(['_current', '_b'])
  })
})

describe('hasProjects', () => {
  it('accepts a dir with projects/ or a projects dir itself', () => {
    const dir = tempDir()
    mkdirSync(join(dir, 'root', 'projects'), { recursive: true })
    mkdirSync(join(dir, 'empty'))
    expect(hasProjects(join(dir, 'root'))).toBe(true)
    expect(hasProjects(join(dir, 'root', 'projects'))).toBe(true)
    expect(hasProjects(join(dir, 'empty'))).toBe(false)
    expect(hasProjects(join(dir, 'missing'))).toBe(false)
  })
})
