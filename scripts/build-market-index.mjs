/** Pin marketplace installation to a reviewed commit, independently of npm authentication. */
import { readFileSync, writeFileSync } from 'node:fs'
const commit = process.argv[2]
if (!/^[a-f\d]{40}$/.test(commit ?? '')) throw new Error('Supply the full 40-character release commit SHA')
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const root = 'https://github.com/Jensen0925/dsh-codearts-dock'
const index = {
  format: 1,
  title: { zh: 'CodeArts Dock 插件索引', en: 'CodeArts Dock plugin index' },
  description: { zh: '项目维护的第三方插件索引；非官方审核或推荐。', en: 'Project-maintained third-party index; not an official review or endorsement.' },
  metadata: { categories: { models: { title: { zh: '模型接入', en: 'Model providers' } } } },
  plugins: [{
    name: pkg.name,
    title: { zh: pkg.displayName, en: 'CodeArts Dock' },
    description: { zh: pkg.description, en: 'Unofficial CodeArts model connector with accounts, credits, presets and encrypted backups.' },
    author: 'Jensen0925', homepage: root,
    repository: { url: root },
    icon: `https://raw.githubusercontent.com/Jensen0925/dsh-codearts-dock/${commit}/icons/dsh-connect-codearts-128.png`,
    metadata: { category: 'models', keywords: pkg.keywords },
    versions: [{ version: pkg.version, publishTimestamp: Math.floor(Date.now() / 1000), source: { type: 'git', url: root, commit } }],
  }],
}
writeFileSync(new URL('../market-index.json', import.meta.url), JSON.stringify(index, null, 2) + '\n')
console.log(`market index: ${pkg.name}@${pkg.version} pinned to ${commit}`)
