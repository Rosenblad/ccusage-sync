// Prints the GitHub release notes for a version: its section of CHANGELOG.md, made to render on a release page.
// Run by .github/workflows/publish.yml with `node scripts/release-notes.ts <version>`; fails if the section is missing.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * The body of the `## [<version>] - <date>` section of a Keep a Changelog file, or undefined if there is none.
 * Relative links point into the repository at the version's tag, since a release page has no base to resolve them
 * against. Hard-wrapped lines are joined, because GitHub renders every newline in a release as a line break.
 */
export function releaseNotes(changelog: string, version: string, repoUrl: string): string | undefined {
  const lines = changelog.split('\n')
  const start = lines.findIndex((line) => line.startsWith(`## [${version}] - `))
  if (start === -1) return undefined
  const rest = lines.slice(start + 1)
  // The section ends at the next version heading, or at the link definitions closing the file.
  const end = rest.findIndex((line) => line.startsWith('## ') || /^\[[^\]]+\]: /.test(line))
  const body = unwrap(end === -1 ? rest : rest.slice(0, end))
    .join('\n')
    .trim()
  if (body === '') return undefined
  const base = `${repoUrl}/blob/v${version}/`
  return body.replace(/\]\((?![a-z][a-z0-9+.-]*:)([^)]+)\)/gi, (_, target: string) =>
    target.startsWith('#') ? `](${base}CHANGELOG.md${target})` : `](${base}${target.replace(/^\.?\//, '')})`,
  )
}

/** Joins each continuation line onto the line before it, leaving blank lines, block starts and code blocks alone. */
function unwrap(lines: string[]): string[] {
  const out: string[] = []
  let fenced = false
  let joinable = false
  for (const line of lines) {
    const fence = /^\s*```/.test(line)
    if (fence) fenced = !fenced
    const blockStart = /^\s*([-*+>#|]|\d+[.)])(\s|$)/.test(line)
    if (joinable && !fenced && !fence && !blockStart && line.trim() !== '') {
      out[out.length - 1] += ` ${line.trim()}`
      continue
    }
    out.push(line)
    joinable = !fenced && !fence && line.trim() !== ''
  }
  return out
}

/** The repository's web URL, from a package.json `repository.url` such as `git+https://github.com/o/r.git`. */
export function repoWebUrl(repositoryUrl: string): string {
  return repositoryUrl.replace(/^git\+/, '').replace(/\.git$/, '')
}

function main(): void {
  const version = process.argv[2]?.replace(/^v/, '')
  if (!version) throw new Error('usage: node scripts/release-notes.ts <version>')
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { repository: { url: string } }
  const notes = releaseNotes(readFileSync('CHANGELOG.md', 'utf8'), version, repoWebUrl(pkg.repository.url))
  if (notes === undefined) {
    console.error(`::error::CHANGELOG.md has no '## [${version}] - <date>' section; move the Unreleased entries under it`)
    process.exit(1)
  }
  console.log(notes)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
