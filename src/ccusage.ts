import { chmodSync, existsSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

export interface CcusageCommand {
  command: string
  args: string[]
}

function nativePackage(platform: string, arch: string): string | undefined {
  const supported = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']
  const key = `${platform}-${arch}`
  return supported.includes(key) ? `@ccusage/ccusage-${key}` : undefined
}

function ensureExecutable(path: string): void {
  if ((statSync(path).mode & 0o111) === 0) chmodSync(path, 0o755)
}

/**
 * Finds the pinned ccusage: its native binary if possible, else its JS launcher run with our node.
 * Resolution is relative to ccusage's own package.json, so it also works under pnpm's strict layout.
 */
export function resolveCcusage(
  platform: string = process.platform,
  arch: string = process.arch,
): CcusageCommand | undefined {
  let ccusagePackageJson: string
  try {
    ccusagePackageJson = createRequire(import.meta.url).resolve('ccusage/package.json')
  } catch {
    return undefined
  }
  const requireFromCcusage = createRequire(ccusagePackageJson)

  const pkg = nativePackage(platform, arch)
  if (pkg) {
    try {
      const binary = requireFromCcusage.resolve(`${pkg}/bin/ccusage`)
      ensureExecutable(binary)
      return { command: binary, args: [] }
    } catch {
      // Fall through to the launcher.
    }
  }

  const launcher = join(dirname(ccusagePackageJson), 'src', 'cli.js')
  return existsSync(launcher) ? { command: process.execPath, args: [launcher] } : undefined
}

export function ccusageVersion(): string | undefined {
  try {
    const require = createRequire(import.meta.url)
    return (require('ccusage/package.json') as { version: string }).version
  } catch {
    return undefined
  }
}

export const CCUSAGE_MISSING = 'ccusage-sync: cannot find ccusage. Reinstall ccusage-sync so the ccusage native binary is installed.'
