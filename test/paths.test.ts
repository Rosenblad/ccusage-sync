import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { configFile, dataDir, hasProjects, localRoots, slotDir, slotName } from '../src/paths.js'
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
