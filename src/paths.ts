import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'

export type Env = Record<string, string | undefined>

export interface PathContext {
  env: Env
  home: string
}

export function defaultPathContext(): PathContext {
  return { env: process.env, home: homedir() }
}

/** An XDG base dir: the variable if it is set to an absolute path (per the spec), else the fallback. */
function xdgDir(ctx: PathContext, name: string, fallback: string): string {
  const value = ctx.env[name]
  return value && isAbsolute(value) ? value : join(ctx.home, fallback)
}

export function configFile(ctx: PathContext): string {
  return join(xdgDir(ctx, 'XDG_CONFIG_HOME', '.config'), 'ccusage-sync', 'config.json')
}

export function dataDir(ctx: PathContext): string {
  return join(xdgDir(ctx, 'XDG_DATA_HOME', '.local/share'), 'ccusage-sync')
}

export function hostDir(data: string, host: string): string {
  return join(data, 'hosts', host)
}

/** `.claude/projects` → `_claude_projects`. Each remote path gets its own slot, so each slot is a ccusage root. */
export function slotName(remotePath: string): string {
  return remotePath.replace(/[^A-Za-z0-9]/g, '_')
}

export function slotDir(data: string, host: string, remotePath: string): string {
  return join(hostDir(data, host), slotName(remotePath))
}

/** The Claude roots ccusage would read on this machine: `$CLAUDE_CONFIG_DIR` entries, or its two defaults. */
export function localRoots(ctx: PathContext): string[] {
  const configured = ctx.env.CLAUDE_CONFIG_DIR
  if (configured && configured.trim() !== '') {
    return configured
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '')
      .map((entry) => resolve(entry))
  }
  return [join(xdgDir(ctx, 'XDG_CONFIG_HOME', '.config'), 'claude'), join(ctx.home, '.claude')]
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** A valid ccusage root is a dir containing `projects/`, or the `projects/` dir itself. */
export function hasProjects(root: string): boolean {
  return isDir(join(root, 'projects')) || (basename(root) === 'projects' && isDir(root))
}

/** Every name `slotName` can give. */
const SLOT_NAME = /^[A-Za-z0-9_]+$/

/**
 * Slots found on disk: dirs holding `projects/`, named the way `slotName` names them. Only for a mirror synced before
 * state.json recorded its slots; anything named otherwise (`x.bak`, `x copy`) was put there by someone else.
 */
export function scanSlots(dir: string): string[] {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.isDirectory() && SLOT_NAME.test(entry.name) && isDir(join(dir, entry.name, 'projects')))
    .map((entry) => entry.name)
    .sort()
}

/**
 * Of the slots a host's mirror is `known` to have, those that aren't for any of `remotePaths` and still hold
 * `projects/`: left over from paths the host no longer has configured. They still hold history the host may have
 * deleted, so they are read, pruned and migrated like the rest.
 */
export function leftoverSlots(dir: string, known: string[], remotePaths: string[]): string[] {
  const current = remotePaths.map(slotName)
  return known.filter((slot) => !current.includes(slot) && isDir(join(dir, slot, 'projects'))).sort()
}

/** Every slot of a host: those of its current paths (which may not exist yet), then leftover ones. */
export function hostSlots(dir: string, known: string[], remotePaths: string[]): string[] {
  return [...new Set(remotePaths.map(slotName)), ...leftoverSlots(dir, known, remotePaths)]
}
