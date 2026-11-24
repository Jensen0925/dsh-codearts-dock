#!/usr/bin/env node
/** Check that a release commit sets a newer package version matching its subject. */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const SUBJECT = /^([a-z]+)(?:\(([a-z0-9][a-z0-9/-]*)\))?(!)?: (\S.*)$/
const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/

function parseVersion(value) {
  const match = value.match(VERSION)
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4] }
}

function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (!a || !b) return Number.NaN
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] - b[key]
  }
  if (a.prerelease === b.prerelease) return 0
  if (a.prerelease === undefined) return 1
  if (b.prerelease === undefined) return -1
  return a.prerelease.localeCompare(b.prerelease)
}

function releaseVersion(subject) {
  const match = subject.match(SUBJECT)
  if (!match || match[1] !== 'chore') return null
  return match[4].match(/^release v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/)?.[1] ?? null
}

/** Return an explanation when a release commit's manifest version is incorrect. */
export function versionBumpProblem(previous, next, subject) {
  const release = releaseVersion(subject)
  if (!release) return null
  if (!parseVersion(previous)) return `invalid base package version: ${previous}`
  if (!parseVersion(next)) return `invalid package version: ${next}`
  if (next !== release) return `release subject names ${release}, but package.json is ${next}`
  if (compareVersions(next, previous) <= 0) return `release version ${next} must be newer than ${previous}`
  return null
}

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function readVersion(json) {
  const manifest = JSON.parse(json)
  return manifest.version
}

function checkCommit(previous, next, subject, label) {
  const problem = versionBumpProblem(previous, next, subject)
  if (problem) {
    console.error(`✗ ${label}: ${problem}`)
    return false
  }
  return true
}

function main(argv) {
  const rangeIndex = argv.indexOf('--range')
  const requireRelease = argv.includes('--release')
  if (rangeIndex === -1 || !argv[rangeIndex + 1]) {
    throw new Error('Usage: node scripts/check-version-bump.mjs --range <base..head>')
  }

  const range = argv[rangeIndex + 1]
  // Auto-generated merge commits carry no independent source change; each
  // non-merge commit in the range is checked against its first parent.
  const commits = git(['rev-list', '--reverse', '--topo-order', '--no-merges', range]).split('\n').filter(Boolean)
  let passed = true
  let releases = 0
  for (const hash of commits) {
    const parent = git(['rev-parse', `${hash}^1`])
    const previous = readVersion(git(['show', `${parent}:package.json`]))
    const next = readVersion(git(['show', `${hash}:package.json`]))
    const subject = git(['show', '-s', '--format=%s', hash])
    if (releaseVersion(subject)) releases += 1
    passed = checkCommit(previous, next, subject, hash.slice(0, 7)) && passed
  }

  if (requireRelease && releases === 0) {
    console.error('✗ release range must contain a `chore: release vX.Y.Z` commit')
    passed = false
  }

  if (passed) console.log(`release version check passed for ${commits.length} commit(s)`)
  process.exitCode = passed ? 0 : 1
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(`check-version-bump: ${error.message}`)
    process.exitCode = 2
  }
}
