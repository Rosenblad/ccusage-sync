export const LOCAL = 'local'

export type Parsed =
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'hosts'; args: string[] }
  | { kind: 'sync'; args: string[]; noSync: boolean; hosts: string[] | undefined }
  | { kind: 'forward'; args: string[]; noSync: boolean; hosts: string[] | undefined }

export class UsageError extends Error {}

/** Splits `a,b` into names. Empty names are rejected. */
function hostList(value: string): string[] {
  const names = value.split(',').map((name) => name.trim())
  if (names.some((name) => name === '')) throw new UsageError(`--hosts expects a comma-separated list of names, got '${value}'`)
  return names
}

/**
 * Removes our flags (`--no-sync`, `--hosts <v>`, `--hosts=<v>`) from anywhere in argv.
 * The first `--` is dropped and everything after it is passed through untouched.
 */
export function stripOurFlags(argv: string[]): { args: string[]; noSync: boolean; hosts: string[] | undefined } {
  const args: string[] = []
  let noSync = false
  let hosts: string[] | undefined
  const addHosts = (value: string) => {
    hosts = [...(hosts ?? []), ...hostList(value)]
  }

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (token === '--') {
      args.push(...argv.slice(i + 1))
      break
    }
    if (token === '--no-sync') {
      noSync = true
    } else if (token === '--hosts') {
      const value = argv[i + 1]
      if (value === undefined) throw new UsageError('--hosts expects a value, e.g. --hosts laptop,local')
      addHosts(value)
      i++
    } else if (token.startsWith('--hosts=')) {
      addHosts(token.slice('--hosts='.length))
    } else {
      args.push(token)
    }
  }
  return { args, noSync, hosts: hosts && [...new Set(hosts)] }
}

export function parseArgv(argv: string[]): Parsed {
  const first = argv[0]
  if (first === '--help' || first === '-h') return { kind: 'help' }
  if (first === '--version' || first === '-v') return { kind: 'version' }
  if (first === 'hosts') return { kind: 'hosts', args: argv.slice(1) }
  if (first === 'sync') return { kind: 'sync', ...stripOurFlags(argv.slice(1)) }
  return { kind: 'forward', ...stripOurFlags(argv) }
}

/** Every `--hosts` name must be a configured host or `local`. */
export function validateHostNames(names: string[], configured: string[]): void {
  const valid = [LOCAL, ...configured]
  const unknown = names.filter((name) => !valid.includes(name))
  if (unknown.length > 0) {
    throw new UsageError(`Unknown host${unknown.length > 1 ? 's' : ''} in --hosts: ${unknown.join(', ')}. Valid names: ${valid.join(', ')}`)
  }
}

/** `statusline` and `claude statusline` never sync: they must answer fast and run without a TTY. */
export function isStatusline(args: string[]): boolean {
  return args[0] === 'statusline' || (args[0] === 'claude' && args[1] === 'statusline')
}
