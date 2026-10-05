import { constants } from 'node:os'

export const FORWARDED_SIGNALS: NodeJS.Signals[] =
  process.platform === 'win32' ? ['SIGINT', 'SIGBREAK', 'SIGHUP'] : ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']

export interface SignalSource {
  on(signal: NodeJS.Signals, handler: () => void): unknown
  off(signal: NodeJS.Signals, handler: () => void): unknown
}

/** Handles the forwarded signals instead of dying on them. Returns a function that removes the handlers. */
export function trapSignals(onSignal: (signal: NodeJS.Signals) => void, source: SignalSource = process): () => void {
  const handlers = FORWARDED_SIGNALS.map((signal) => {
    const handler = () => onSignal(signal)
    source.on(signal, handler)
    return [signal, handler] as const
  })
  return () => {
    for (const [signal, handler] of handlers) source.off(signal, handler)
  }
}

/** The shell convention for a process killed by a signal. */
export function signalExitCode(signal: NodeJS.Signals): number {
  return 128 + (constants.signals[signal] ?? 0)
}
