/**
 * Generate market-index.json for the Discover page.
 *
 * Two install sources, both format 1:
 *
 *   node scripts/build-market-index.mjs --npm [--registry=https://registry.npmjs.org/]
 *   node scripts/build-market-index.mjs --git <40-hex-commit>
 *
 * `--npm` publishes a registry source, so the index installs `name@version` from
 * npm the same way `npm publish` ships it, and the entry keeps tracking new
 * versions instead of freezing one commit. `--git` pins a reviewed commit, which
 * still works before a release reaches the registry (a Git entry updates only
 * within its own repository, so it is the fallback rather than the default).
 *
 * The npm path asks the registry for the real publish time, because
 * `publishTimestamp` is display text: a locally invented one would show the day
 * the index was rebuilt, not the day the version shipped.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const ROOT = 'https://github.com/Jensen0925/dsh-codearts-dock'
const REGISTRY = 'https://registry.npmjs.org/'
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

const args = process.argv.slice(2)
const mode = args.includes('--npm') ? 'npm' : args.includes('--git') ? 'git' : null
if (mode === null) throw new Error('Choose a source: --npm, or --git <40-hex commit>')

const gitCommit = args.find((a) => !a.startsWith('--') && /^[a-f\d]{40}$/.test(a))
if (mode === 'git' && !gitCommit) throw new Error('--git needs the full 40-character release commit SHA')

const registryArg = args.find((a) => a.startsWith('--registry='))
const registry = registryArg ? registryArg.slice('--registry='.length) : REGISTRY

/**
 * Real publish time from the registry, or undefined when the version is not there.
 *
 * The full `application/json` packument is requested on purpose: the abbreviated
 * `install-v1+json` form omits `time` entirely, so asking for it would return
 * "no publish time" for a version that plainly has one.
 */
async function publishedAt(version) {
  try {
    const response = await fetch(`${registry}${encodeURIComponent(pkg.name)}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    })
    if (!response.ok) return undefined
    const body = await response.json()
    const stamp = Date.parse(body?.time?.[version] ?? '')
    return Number.isFinite(stamp) ? Math.floor(stamp / 1000) : undefined
  } catch {
    return undefined
  }
}

const source =
  mode === 'npm'
    ? { type: 'npm', ...(registry === REGISTRY ? {} : { registry }) }
    : { type: 'git', url: ROOT, commit: gitCommit }

const fromRegistry = await publishedAt(pkg.version)
if (mode === 'npm' && fromRegistry === undefined) {
  // Printed, not thrown: this is the ordinary state right before a release, and
  // a stack trace makes it look like the generator is broken.
  console.error(
    `${pkg.name}@${pkg.version} is not on ${registry}. Publish it first, or build a git-pinned index with --git <commit>.`,
  )
  process.exit(1)
}
const publishTimestamp = fromRegistry ?? Math.floor(Date.now() / 1000)

// The icon is served from raw.githubusercontent, which needs a ref rather than a
// package name. A git source already carries a reviewed commit; an npm source
// points at this version's tag, which the release workflow creates alongside the
// publish, so the artwork matches the version it describes.
const iconRef = gitCommit ?? `v${pkg.version}`

const index = {
  format: 1,
  title: { zh: 'CodeArts Dock 插件索引', en: 'CodeArts Dock plugin index' },
  description: { zh: '项目维护的第三方插件索引；非官方审核或推荐。', en: 'Project-maintained third-party index; not an official review or endorsement.' },
  metadata: { categories: { models: { title: { zh: '模型接入', en: 'Model providers' } } } },
  plugins: [{
    name: pkg.name,
    title: { zh: pkg.displayName, en: 'CodeArts Dock' },
    description: { zh: pkg.description, en: 'Unofficial CodeArts model connector with accounts, credits, model configuration and local activity history.' },
    author: 'Jensen0925',
    homepage: ROOT,
    repository: { url: ROOT },
    icon: `https://raw.githubusercontent.com/Jensen0925/dsh-codearts-dock/${iconRef}/icons/dsh-codearts-dock-128.png`,
    metadata: { category: 'models', keywords: pkg.keywords },
    versions: [{ version: pkg.version, publishTimestamp, source }],
  }],
}

writeFileSync(new URL('../market-index.json', import.meta.url), JSON.stringify(index, null, 2) + '\n')
const origin = source.type === 'npm' ? `npm ${registry}` : `git ${gitCommit.slice(0, 7)}`
console.log(`market index: ${pkg.name}@${pkg.version} from ${origin}`)
