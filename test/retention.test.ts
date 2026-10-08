import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { claudeCleanupDays, claudeConfigDir, claudeSettingsFiles, retentionMs } from '../src/retention.js'
import { tempDir } from './helpers.js'

const DAY = 86_400_000

/** A reader over in-memory files. A string is the file's text; an Error is thrown as is. */
function reader(files: Record<string, string | Error>) {
  return (file: string) => {
    const content = files[file]
    if (content === undefined) throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' })
    if (content instanceof Error) throw content
    return content
  }
}

describe('claudeCleanupDays', () => {
  const files = ['managed', 'remote', 'user']

  it('defaults to 30 days, like Claude Code', () => {
    expect(claudeCleanupDays(files, reader({}))).toBe(30)
    expect(claudeCleanupDays(files, reader({ user: '{"model":"opus"}' }))).toBe(30)
  })

  it('takes the first file that sets it', () => {
    expect(claudeCleanupDays(files, reader({ user: '{"cleanupPeriodDays":90}' }))).toBe(90)
    expect(claudeCleanupDays(files, reader({ managed: '{"cleanupPeriodDays":7}', user: '{"cleanupPeriodDays":90}' }))).toBe(7)
    expect(claudeCleanupDays(files, reader({ remote: '{}', user: '{"cleanupPeriodDays":90}' }))).toBe(90)
  })

  it('keeps everything when Claude Code would pause its cleanup', () => {
    for (const value of ['0', '-1', '1.5', '"30"', 'null']) {
      expect(claudeCleanupDays(files, reader({ user: `{"cleanupPeriodDays":${value}}` }))).toBeUndefined()
    }
    expect(claudeCleanupDays(files, reader({ user: '{' }))).toBeUndefined()
    const denied = Object.assign(new Error('EACCES'), { code: 'EACCES' })
    expect(claudeCleanupDays(files, reader({ user: denied }))).toBeUndefined()
  })
})

describe('settings locations', () => {
  it('reads managed settings, then server-managed, then user settings', () => {
    const ctx = { env: {}, home: '/home/u' }
    expect(claudeSettingsFiles(ctx, 'linux')).toEqual([
      '/etc/claude-code/managed-settings.json',
      '/home/u/.claude/remote-settings.json',
      '/home/u/.claude/settings.json',
    ])
    expect(claudeSettingsFiles(ctx, 'darwin')[0]).toBe('/Library/Application Support/ClaudeCode/managed-settings.json')
  })

  it('follows CLAUDE_CONFIG_DIR, taking the first of a ccusage-style list', () => {
    expect(claudeConfigDir({ env: { CLAUDE_CONFIG_DIR: '/work/claude' }, home: '/home/u' })).toBe('/work/claude')
    expect(claudeConfigDir({ env: { CLAUDE_CONFIG_DIR: '/a, /b' }, home: '/home/u' })).toBe('/a')
    expect(claudeConfigDir({ env: { CLAUDE_CONFIG_DIR: ' ' }, home: '/home/u' })).toBe('/home/u/.claude')
  })
})

describe('retentionMs', () => {
  it('handles forever and durations', () => {
    const ctx = { env: {}, home: tempDir() }
    expect(retentionMs('forever', ctx)).toBeUndefined()
    expect(retentionMs('90d', ctx)).toBe(90 * DAY)
    expect(retentionMs('12h', ctx)).toBe(12 * 3_600_000)
  })

  it('follows cleanupPeriodDays in the user settings for "claude"', () => {
    const dir = tempDir()
    const ctx = { env: { CLAUDE_CONFIG_DIR: dir }, home: dir }
    // Assumes no managed settings file on the machine running the tests.
    expect(retentionMs('claude', ctx)).toBe(30 * DAY)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'settings.json'), '{"cleanupPeriodDays": 14}')
    expect(retentionMs('claude', ctx)).toBe(14 * DAY)
  })
})
