// Opens a GitHub issue when the minimum Node version (engines.node) is about to reach end of life.
// Run monthly by .github/workflows/node-eol.yml with `node scripts/check-node-eol.ts`; needs `gh` and GH_TOKEN.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const API = 'https://endoflife.date/api/v1/products/nodejs'
const WARN_DAYS = 60
const DAY_MS = 86_400_000

export interface NodeRelease {
  name: string
  isLts: boolean
  isEol: boolean
  eolFrom: string | null
}

export interface NodeEol {
  floor: number
  eolFrom: string
  daysLeft: number
  /** Whether to open the reminder: end of life is within WARN_DAYS, or already past. */
  due: boolean
  /** The oldest LTS major after `floor` that is still maintained, if any. */
  next: number | undefined
}

/** The major version in `engines.node`, e.g. 22 for ">=22". */
export function nodeFloor(enginesNode: string): number {
  const m = /^>=\s*(\d+)(\.\d+)*$/.exec(enginesNode.trim())
  if (!m) throw new Error(`engines.node must look like ">=22", got ${JSON.stringify(enginesNode)}`)
  return Number(m[1])
}

export function nodeEol(floor: number, releases: NodeRelease[], today: Date): NodeEol {
  const release = releases.find((r) => r.name === String(floor))
  if (!release?.eolFrom) throw new Error(`endoflife.date has no end-of-life date for Node ${floor}`)
  const daysLeft = Math.ceil((Date.parse(release.eolFrom) - today.getTime()) / DAY_MS)
  const next = releases
    .filter((r) => r.isLts && !r.isEol && Number(r.name) > floor)
    .map((r) => Number(r.name))
    .sort((a, b) => a - b)[0]
  return { floor, eolFrom: release.eolFrom, daysLeft, due: daysLeft <= WARN_DAYS, next }
}

export function issueTitle(floor: number): string {
  return `Raise the minimum Node version from ${floor}`
}

export function issueBody({ floor, eolFrom, next }: NodeEol): string {
  const to = next === undefined ? 'the oldest maintained LTS line' : `Node ${next}, the oldest LTS line still maintained`
  const types = next === undefined ? '@types/node@<new>' : `@types/node@${next}`
  return `Node ${floor} reaches end of life on ${eolFrom}. Raise the minimum to ${to}:

- [ ] \`engines.node\` in \`package.json\`
- [ ] \`target\` in \`tsdown.config.ts\`
- [ ] \`npm install -D -E ${types}\`, and its \`allowedVersions\` in \`renovate.json\`
- [ ] "Node.js ${floor} or later" in \`README.md\`
- [ ] The Node versions in the \`.github/workflows/ci.yml\` matrix

\`test/node-version.test.ts\` fails until these agree. Dropping a Node version is a breaking change, so release it as a
minor bump while the version is 0.x.

Opened by \`.github/workflows/node-eol.yml\`.
`
}

function gh(...args: string[]): string {
  return execFileSync('gh', args, { encoding: 'utf8' })
}

async function main(): Promise<void> {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { engines: { node: string } }
  const floor = nodeFloor(pkg.engines.node)

  const res = await fetch(API)
  if (!res.ok) throw new Error(`${API}: HTTP ${res.status}`)
  const { result } = (await res.json()) as { result: { releases: NodeRelease[] } }

  const eol = nodeEol(floor, result.releases, new Date())
  const when = eol.daysLeft < 0 ? `${-eol.daysLeft} days ago` : `${eol.daysLeft} days from now`
  console.log(`Node ${floor} reaches end of life on ${eol.eolFrom} (${when}).`)
  if (!eol.due) return

  const title = issueTitle(floor)
  const open = JSON.parse(gh('issue', 'list', '--state', 'open', '--limit', '500', '--json', 'title')) as { title: string }[]
  if (open.some((issue) => issue.title === title)) {
    console.log(`Reminder already open: ${title}`)
    return
  }
  console.log(gh('issue', 'create', '--title', title, '--body', issueBody(eol)).trim())
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main()
