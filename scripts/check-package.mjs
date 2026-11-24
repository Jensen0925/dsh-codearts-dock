#!/usr/bin/env node
/** Scan source/docs/tests and the exact npm archive for credential or path leaks. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const temp = mkdtempSync(join(process.env.TMPDIR || '/tmp', 'dsh-codearts-package-'))
const textExtensions = new Set(['.cjs', '.js', '.json', '.mjs', '.md', '.patch', '.sh', '.ts', '.txt', '.yml', '.yaml'])
const placeholder = /(?:test|example|dummy|placeholder|redacted|masked|offline|sample|fake|secret_|raw_|temp_|pair|one|two|old|new|backup|wrong)[_-]?/i
const rules = [
  ['private key header', /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
  ['absolute macOS/Linux path', /(?:^|["'`\s(=])(?:\/Users\/[A-Za-z0-9._-]+(?:\/|$)|\/home\/[A-Za-z0-9._-]+(?:\/|$))/],
  ['absolute Windows user path', /(?:^|["'`\s(=])[A-Za-z]:\\Users\\[A-Za-z0-9._-]+\\/],
  ['credential URL', /https?:\/\/[^\s:@/]+:[^\s@/]+@/i],
]
const assignment = /\b(?:accessKey(?:Id)?|secretAccessKey|securityToken|(?:api|auth|access|refresh)?token|secret|password|passwd|privateKey|ak|sk)\b\s*[:=]\s*['"`]([^'"`\r\n]{12,})['"`]/gi
const envAssignment = /\b(?:CODEARTS_(?:AK|SK|SECURITY_TOKEN)|NPM_TOKEN|GITHUB_TOKEN)\s*=\s*([^\s#]{12,})/g

function walk(directory) {
  const files = []
  for (const name of readdirSync(directory)) {
    const path = join(directory, name)
    const stat = statSync(path)
    if (stat.isDirectory()) files.push(...walk(path))
    else files.push(path)
  }
  return files
}

function scanFile(path, label) {
  if (!textExtensions.has(extname(path).toLowerCase())) return []
  const content = readFileSync(path, 'utf8')
  const hits = []
  for (const [rule, pattern] of rules) {
    if (pattern.test(content)) hits.push(`${label}: ${rule}`)
    pattern.lastIndex = 0
  }
  for (const match of content.matchAll(assignment)) {
    if (match[0].includes('`')) continue
    if (!placeholder.test(match[1])) {
      hits.push(`${label}: credential-like ${match[0].split(/[:=]/, 1)[0].trim()}`)
    }
  }
  assignment.lastIndex = 0
  for (const match of content.matchAll(envAssignment)) {
    if (!placeholder.test(match[1])) hits.push(`${label}: credential-like environment variable`)
  }
  envAssignment.lastIndex = 0
  return hits
}

function scanTree(directory, labelRoot = directory) {
  return walk(directory).flatMap((path) => scanFile(path, relative(labelRoot, path) || path))
}

const localFiles = [
  'README.md',
  'CHANGELOG.md',
  'DISCLAIMER.md',
  'SECURITY.md',
  'THIRD_PARTY_NOTICES.md',
  'client.js',
  'src',
  'docs',
  'tests',
  'scripts',
].flatMap((entry) => {
  const path = resolve(root, entry)
  return statSync(path).isDirectory() ? scanTree(path, root) : scanFile(path, entry)
})
assert.deepEqual(localFiles, [], `sensitive information found in source/docs/tests:\n${localFiles.join('\n')}`)

const packInfo = JSON.parse(
  execFileSync('pnpm', ['--config.ignore-scripts=true', 'pack', '--json', '--pack-destination', temp], {
    cwd: root,
    encoding: 'utf8',
  }),
)
const archive = resolve(packInfo.filename)
execFileSync('tar', ['-xzf', archive, '-C', temp])
const packageRoot = join(temp, 'package')
const packageHits = scanTree(packageRoot, packageRoot)
assert.deepEqual(packageHits, [], `sensitive information found in package archive:\n${packageHits.join('\n')}`)

rmSync(temp, { recursive: true, force: true })
console.log('package: source/docs/tests and package archive passed privacy scan')
