import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseDuration } from './config.js'
import type { PathContext } from './paths.js'

const DAY_MS = 86_400_000

/** Claude Code's own default for cleanupPeriodDays. */
export const CLAUDE_DEFAULT_CLEANUP_DAYS = 30

/**
 * Mirrored files are deleted this long after they leave the retention window, so a clock difference between the host
 * (whose clock decides what is listed) and this machine (whose clock decides what is deleted) can't make a file be
 * deleted here and fetched again on every sync.
 */
export const PRUNE_MARGIN_MS = DAY_MS

/** Where Claude Code keeps its settings on this machine. ccusage accepts a comma list; Claude Code itself uses one dir. */
export function claudeConfigDir(ctx: PathContext): string {
  const first = ctx.env.CLAUDE_CONFIG_DIR?.split(',')[0]?.trim()
  return first || join(ctx.home, '.claude')
}

/**
 * Claude Code's settings files that can set cleanupPeriodDays, highest precedence first: the managed settings file,
 * the cached server-managed settings, then user settings. Project settings are left out: they vary by directory.
 */
export function claudeSettingsFiles(ctx: PathContext, platform: string = process.platform): string[] {
  const managed =
    platform === 'darwin' ? '/Library/Application Support/ClaudeCode/managed-settings.json' : '/etc/claude-code/managed-settings.json'
  const dir = claudeConfigDir(ctx)
  return [managed, join(dir, 'remote-settings.json'), join(dir, 'settings.json')]
}

type Lookup = { found: false } | { found: true; days: number | undefined }

/** One settings file's cleanupPeriodDays. `days` is undefined when Claude Code would pause its cleanup over this file. */
function lookup(file: string, read: (file: string) => string): Lookup {
  let text: string
  try {
    text = read(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { found: false }
    return { found: true, days: undefined }
  }
  let settings: unknown
  try {
    settings = JSON.parse(text)
  } catch {
    return { found: true, days: undefined }
  }
  if (typeof settings !== 'object' || settings === null || !('cleanupPeriodDays' in settings)) return { found: false }
  const days = settings.cleanupPeriodDays
  return { found: true, days: Number.isInteger(days) && (days as number) >= 1 ? (days as number) : undefined }
}

/**
 * The number of days Claude Code keeps transcripts on this machine, or undefined if it would keep them forever: when a
 * settings file can't be read or parsed, or sets an invalid value, Claude Code pauses its cleanup, and so do we.
 */
export function claudeCleanupDays(
  files: string[],
  read: (file: string) => string = (file) => readFileSync(file, 'utf8'),
): number | undefined {
  for (const file of files) {
    const result = lookup(file, read)
    if (result.found) return result.days
  }
  return CLAUDE_DEFAULT_CLEANUP_DAYS
}

/** The retention window in ms, or undefined to keep mirrored files forever. */
export function retentionMs(setting: string, ctx: PathContext): number | undefined {
  if (setting === 'forever') return undefined
  if (setting === 'claude') {
    const days = claudeCleanupDays(claudeSettingsFiles(ctx))
    return days === undefined ? undefined : days * DAY_MS
  }
  return parseDuration(setting)
}
