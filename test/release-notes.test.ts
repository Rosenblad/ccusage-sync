import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { releaseNotes, repoWebUrl } from '../scripts/release-notes.js'

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const REPO = 'https://github.com/o/r'

const CHANGELOG = `# Changelog

Intro text.

## [Unreleased]

- Not released yet.

## [0.2.0] - 2026-10-08

### Added

- A feature, described over
  two lines. See [Usage](README.md#usage) and [above](#010---2026-10-05).
- [ccusage](https://github.com/ryoppippi/ccusage) 20.0.27.

\`\`\`json
{ "a": 1,
  "b": 2 }
\`\`\`

## [0.1.0] - 2026-10-05

Initial release,
wrapped.

[Unreleased]: ${REPO}/compare/v0.2.0...HEAD
[0.2.0]: ${REPO}/compare/v0.1.0...v0.2.0
`

describe('releaseNotes', () => {
  it('is the version section, up to the next version', () => {
    const notes = releaseNotes(CHANGELOG, '0.2.0', REPO)
    expect(notes).toMatch(/^### Added\n\n- A feature/)
    expect(notes).toMatch(/```$/)
  })

  it('stops the last section at the link definitions', () => {
    expect(releaseNotes(CHANGELOG, '0.1.0', REPO)).toBe('Initial release, wrapped.')
  })

  it('joins wrapped lines, but not list items or code blocks', () => {
    const notes = releaseNotes(CHANGELOG, '0.2.0', REPO)
    expect(notes).toContain('- A feature, described over two lines.')
    expect(notes).toContain('\n- [ccusage]')
    expect(notes).toContain('{ "a": 1,\n  "b": 2 }')
  })

  it('points relative links into the repository at the tag', () => {
    const notes = releaseNotes(CHANGELOG, '0.2.0', REPO)
    expect(notes).toContain(`[Usage](${REPO}/blob/v0.2.0/README.md#usage)`)
    expect(notes).toContain(`[above](${REPO}/blob/v0.2.0/CHANGELOG.md#010---2026-10-05)`)
    expect(notes).toContain('[ccusage](https://github.com/ryoppippi/ccusage)')
  })

  it('is undefined for a version without a dated section', () => {
    expect(releaseNotes(CHANGELOG, '0.3.0', REPO)).toBeUndefined()
    expect(releaseNotes(CHANGELOG, 'Unreleased', REPO)).toBeUndefined()
    expect(releaseNotes('## [0.3.0] - 2026-10-09\n\n## [0.2.0] - 2026-10-08\n', '0.3.0', REPO)).toBeUndefined()
  })
})

describe('repoWebUrl', () => {
  it('strips the git+ prefix and .git suffix', () => {
    expect(repoWebUrl('git+https://github.com/o/r.git')).toBe(REPO)
  })
})

// The publish workflow refuses a tag without notes, so catch a release PR that forgot them before it is merged.
it('CHANGELOG.md has notes for the version in package.json', () => {
  const pkg = JSON.parse(read('package.json'))
  expect(releaseNotes(read('CHANGELOG.md'), pkg.version, repoWebUrl(pkg.repository.url))).toBeDefined()
})
