import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect } from 'vitest'
import { createStreamRunner, type StreamRunner } from '../src/fetch.js'
import { createRunner, type Runner } from '../src/sync.js'

const dirs: string[] = []

/** A fresh temp dir, removed after the test. */
export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ccusage-sync-test-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** `ssh <host> sh -s` run locally, in `home` as the host's home directory. `calls` records each command. */
export function localHost(home: string) {
  const calls: string[] = []
  const toLocal = (command: string, args: string[]): [string, string[]] => {
    calls.push(command)
    expect(command).toBe('ssh')
    expect(args.slice(-2)).toEqual(['sh', '-s'])
    return ['sh', ['-c', `cd '${home}' && exec sh -s`]]
  }
  const runner = createRunner()
  const streamer = createStreamRunner()
  const run: Runner = (command, args, input) => runner(...toLocal(command, args), input)
  const stream: StreamRunner = (command, args, input, onStdout) => streamer(...toLocal(command, args), input, onStdout)
  return { run, stream, calls }
}
