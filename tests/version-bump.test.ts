import assert from 'node:assert/strict'
import { test } from 'vitest'
import { versionBumpProblem } from '../scripts/check-version-bump.mjs'

test('ordinary commits do not require a version change', () => {
  assert.equal(versionBumpProblem('1.3.0', '1.3.0', 'fix: correct account parsing'), null)
  assert.equal(versionBumpProblem('1.3.0', '1.3.0', 'feat: add model status'), null)
  assert.equal(versionBumpProblem('1.3.0', '1.3.0', 'test: migrate suites'), null)
})

test('release commits must name the exact new version', () => {
  assert.equal(versionBumpProblem('1.3.0', '1.4.0', 'chore: release v1.4.0'), null)
  assert.match(versionBumpProblem('1.3.0', '1.3.1', 'chore: release v1.4.0') ?? '', /names 1\.4\.0/)
  assert.match(versionBumpProblem('1.3.0', '1.3.0', 'chore: release v1.3.0') ?? '', /must be newer/)
})

test('release versions must advance beyond the previous version', () => {
  assert.match(versionBumpProblem('1.3.0', '1.3.0', 'chore: release v1.3.0') ?? '', /must be newer/)
  assert.match(versionBumpProblem('1.3.0', '1.2.9', 'chore: release v1.2.9') ?? '', /must be newer/)
})
