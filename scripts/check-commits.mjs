#!/usr/bin/env node
/**
 * Enforce this repository's commit message convention.
 *
 * Read `docs/COMMITS.md` for the rule and why it exists. This script is the
 * executable half; keep the two in step, because a rule that lives only in
 * prose is a rule nobody follows after the first busy week.
 *
 *   node scripts/check-commits.mjs                    # CI: the range a push added
 *   node scripts/check-commits.mjs --range A..B       # an explicit range
 *   node scripts/check-commits.mjs --last 5           # the last N subjects
 *   node scripts/check-commits.mjs --message-file F   # a hook's COMMIT_EDITMSG
 *
 * Exit codes: 0 clean, 1 violations, 2 the range could not be determined (a
 * checkout too shallow to see the base commit, say). 2 is distinct on purpose:
 * "cannot check" must not read as "checked and passed".
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))

/**
 * The types in use here, each with the boundary it draws. A commit that fits
 * none of them is usually two commits, not a new type.
 */
export const TYPES = {
  feat: 'a user-visible capability or change in behaviour',
  fix: 'a defect correction, including its test',
  chore: 'bookkeeping with no behaviour change (release bump, index repin, deps)',
  docs: 'prose only: README, SECURITY, docs/, comments that ship as documentation',
  refactor: 'same behaviour, different structure (renames, extraction)',
  test: 'test-only additions or fixes',
  perf: 'same behaviour, measured faster',
}

/**
 * Commit this rename landed in. History before it is not re-checked: rewriting
 * it would change published SHAs, and the convention applies from here on.
 */
export const BASELINE = 'aae786792c0ccb763cb8a3128202694e696a05f6'

/** Hard ceiling on the subject, in characters. */
export const SUBJECT_MAX = 74

/** The line that tells a later reader a rule was not guessed. */
const RULE = /^([a-z]+)(?:\(([a-z0-9][a-z0-9/-]*)\))?(!)?: (\S.*)$/

/**
 * Check one commit message and return its problems.
 *
 * @param {string} message the raw message (`%B`), subject first.
 * @param {object} [options]
 * @param {string} [options.hash] shown in the report.
 * @returns {string[]} one line per problem; empty means the message is fine.
 */
export function problems(message, { hash } = {}) {
  const where = hash ? `${hash.slice(0, 7)} ` : ''
  const lines = message.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n')
  const subject = lines[0] ?? ''
  const body = lines.slice(1).join('\n')
  const found = []

  if (subject.trim() === '') return [`${where}empty subject`]
  if (subject !== subject.trimEnd()) found.push(`${where}subject has trailing whitespace: ${JSON.stringify(subject)}`)

  const match = subject.match(RULE)
  if (!match) {
    found.push(`${where}subject is not "type(scope): summary": ${subject}`)
  } else {
    const [, type, scope, bang, summary] = match
    if (!(type in TYPES)) {
      found.push(`${where}unknown type "${type}"; use one of ${Object.keys(TYPES).join(', ')}`)
    }
    // A scope is optional, but an empty one is a typo, not a choice.
    if (scope !== undefined && scope.trim() === '') found.push(`${where}empty scope in "(${scope})"`)

    if (summary.trim() === '') found.push(`${where}empty summary after the colon`)
    // Lower case, unless the first word is a name that is written capitalised
    // — `README`, `CodeArts`, `DSH`. Those are recognised by having an interior
    // capital or being all-caps; a sentence's first word is not.
    const first = summary.split(/\s+/)[0].replace(/[^A-Za-z0-9/-]/g, '')
    if (/^[A-Z]/.test(first) && !/^[A-Z][a-z]/.test(first) && !/^[A-Z]{2,}/.test(first)) {
      found.push(`${where}summary starts with a capital letter; write it in lower case: ${subject}`)
    }
    if (/\s$/.test(summary)) found.push(`${where}summary ends with a space`)
  }

  if (subject.length > SUBJECT_MAX) {
    found.push(`${where}subject is ${subject.length} characters; the limit is ${SUBJECT_MAX}: ${subject}`)
  }
  if (/[.;:,]$/.test(subject)) found.push(`${where}subject ends with punctuation; drop it: ${subject}`)

  // The project's one deliberate departure from common practice: no body.
  // The reasoning lives in docs/COMMITS.md; this is where it is enforced.
  if (body.trim() !== '') {
    const extra = body.split('\n').filter((line) => line.trim() !== '').length
    found.push(`${where}commit has a ${extra}-line body; this repository keeps a single-line subject (see docs/COMMITS.md)`)
  }

  return found
}

/** Run git in this repository and return its stdout. */
function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/** Whether this checkout has the baseline commit at all. */
function hasBaseline() {
  try {
    git(['cat-file', '-e', `${BASELINE}^{commit}`])
    return true
  } catch {
    return false
  }
}

/**
 * Resolve the commits to check.
 *
 * A shallow CI checkout has no merge base, so the range is unanswerable rather
 * than empty — reported as such instead of silently passing.
 *
 * @returns {{commits: {hash: string, message: string}[], scope: string}|null}
 */
function collect(argv) {
  const flag = (name) => {
    const at = argv.indexOf(name)
    return at === -1 ? undefined : argv[at + 1]
  }

  const messageFile = flag('--message-file')
  if (messageFile !== undefined) {
    return {
      scope: messageFile,
      commits: [{ hash: '', message: readFileSync(messageFile, 'utf8') }],
    }
  }

  const last = flag('--last')
  if (last !== undefined) {
    const count = Number.parseInt(last, 10)
    if (!Number.isInteger(count) || count < 1) return null
    const out = git(['log', `-n${count}`, '--format=%H%x1f%B%x1e'])
    return { scope: `the last ${count} commit(s)`, commits: parse(out) }
  }

  let range = flag('--range')
  if (range === undefined) {
    // What a push added: the merge base with the upstream branch. On a branch
    // with no upstream yet, fall back to the baseline so a first push is checked.
    const base = hasBaseline() ? BASELINE : null
    try {
      const mergeBase = git(['merge-base', 'HEAD', 'origin/main']).trim()
      range = `${mergeBase}..HEAD`
    } catch {
      range = base === null ? 'HEAD' : `${base}..HEAD`
    }
  }
  // An empty range (nothing since the merge base) is a pass, not a failure.
  if (range.endsWith('..HEAD') && range === 'HEAD') {
    const out = git(['log', '--format=%H%x1f%B%x1e', 'HEAD'])
    return { scope: 'HEAD', commits: parse(out) }
  }
  const out = git(['log', '--format=%H%x1f%B%x1e', range])
  return { scope: range, commits: parse(out) }
}

/** Split `%H\x1f%B\x1e` output into commit records. */
function parse(out) {
  return out
    .split('\x1e')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const [hash, ...rest] = chunk.split('\x1f')
      return { hash, message: rest.join('\x1f') }
    })
}

// ── entry point ─────────────────────────────────────────────────────────────
// Imported by the test suite for `problems`, so only run when executed.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2)
  const collected = collect(argv)
  if (collected === null) {
    console.error('check-commits: could not determine which commits to check')
    process.exit(2)
  }

  let failed = 0
  for (const { hash, message } of collected.commits) {
    for (const problem of problems(message, { hash })) {
      console.error(`✗ ${problem}`)
      failed += 1
    }
  }

  if (failed === 0) {
    const count = collected.commits.length
    console.log(`commits: ${count === 0 ? 'nothing to check in' : `${count} commit(s) in`} ${collected.scope} conform`)
    process.exit(0)
  }
  console.error(`\ncommits: ${failed} problem(s) in ${collected.scope}. See docs/COMMITS.md.`)
  process.exit(1)
}
