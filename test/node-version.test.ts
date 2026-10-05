import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { issueBody, nodeEol, nodeFloor, type NodeRelease } from '../scripts/check-node-eol.js'

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

// Raising the minimum Node version touches all of these; keep them in step.
describe('minimum Node version', () => {
  const pkg = JSON.parse(read('package.json'))
  const floor = nodeFloor(pkg.engines.node)

  it('is the build target', () => {
    expect(read('tsdown.config.ts')).toContain(`target: 'node${floor}'`)
  })

  it('is the @types/node major, capped in renovate.json', () => {
    expect(pkg.devDependencies['@types/node']).toMatch(new RegExp(`^${floor}\\.`))
    const rule = JSON.parse(read('renovate.json')).packageRules.find((r: { matchPackageNames?: string[] }) =>
      r.matchPackageNames?.includes('@types/node'),
    )
    expect(rule?.allowedVersions).toBe(`<${floor + 1}`)
  })

  it('is the requirement in the README', () => {
    expect(read('README.md')).toContain(`- Node.js ${floor} or later`)
  })

  it('is the oldest version CI tests', () => {
    const matrix = /^\s*node: \[([^\]]*)\]/m.exec(read('.github/workflows/ci.yml'))?.[1] ?? ''
    expect(Math.min(...matrix.split(',').map(Number))).toBe(floor)
  })
})

describe('nodeFloor', () => {
  it('reads the major from a >= range', () => {
    expect(nodeFloor('>=22')).toBe(22)
    expect(nodeFloor('>= 22.12.0')).toBe(22)
  })

  it('rejects ranges it cannot check', () => {
    expect(() => nodeFloor('^22 || ^24')).toThrow(/engines.node must look like/)
  })
})

describe('nodeEol', () => {
  const releases: NodeRelease[] = [
    { name: '26', isLts: true, isEol: false, eolFrom: '2029-04-30' },
    { name: '25', isLts: false, isEol: true, eolFrom: '2026-06-01' },
    { name: '24', isLts: true, isEol: false, eolFrom: '2028-04-30' },
    { name: '22', isLts: true, isEol: false, eolFrom: '2027-04-30' },
  ]

  it('is not due more than 60 days ahead', () => {
    expect(nodeEol(22, releases, new Date('2026-10-05'))).toEqual({
      floor: 22,
      eolFrom: '2027-04-30',
      daysLeft: 207,
      due: false,
      next: 24,
    })
  })

  it('is due within 60 days, and after end of life', () => {
    expect(nodeEol(22, releases, new Date('2027-03-01')).due).toBe(true)
    expect(nodeEol(22, releases, new Date('2027-06-01'))).toMatchObject({ due: true, daysLeft: -32 })
  })

  it('skips non-LTS and end-of-life lines when suggesting the next minimum', () => {
    expect(nodeEol(24, releases, new Date('2028-03-01')).next).toBe(26)
    expect(nodeEol(26, releases, new Date('2029-03-01')).next).toBeUndefined()
  })

  it('fails when the minimum is unknown to endoflife.date', () => {
    expect(() => nodeEol(20, releases, new Date())).toThrow(/no end-of-life date for Node 20/)
  })

  it('names the next version in the issue', () => {
    const body = issueBody(nodeEol(22, releases, new Date('2027-03-01')))
    expect(body).toContain('Raise the minimum to Node 24')
    expect(body).toContain('npm install -D -E @types/node@24')
  })
})
