#!/usr/bin/env node
/**
 * Fills in the GitHub placeholders before the first push.
 *
 *   node scripts/set-repo.mjs lucki
 *   node scripts/set-repo.mjs lucki dynamic-island
 *
 * Replaces every YOUR-GITHUB-USERNAME occurrence in the docs, package.json and
 * the release workflow, and sets the repository URL.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const [user, repo = 'dynamic-island'] = process.argv.slice(2)

if (!user) {
  console.error('usage: node scripts/set-repo.mjs <github-username> [repo-name]')
  process.exit(1)
}

const targets = [
  'README.md',
  'CONTRIBUTING.md',
  'package.json',
  '.github/workflows/release.yml'
]

let changed = 0
for (const rel of targets) {
  const file = path.join(root, rel)
  if (!fs.existsSync(file)) continue
  const before = fs.readFileSync(file, 'utf8')
  const after = before.replaceAll('YOUR-GITHUB-USERNAME', user)
  if (after !== before) {
    fs.writeFileSync(file, after)
    changed += 1
    console.log(`updated ${rel}`)
  }
}

const pkgFile = path.join(root, 'package.json')
const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'))
pkg.homepage = `https://github.com/${user}/${repo}`
pkg.repository = { type: 'git', url: `https://github.com/${user}/${repo}.git` }
pkg.bugs = { url: `https://github.com/${user}/${repo}/issues` }
fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n')

console.log(`\ndone - ${changed} file(s) + package.json now point at github.com/${user}/${repo}`)
console.log('\nnext:')
console.log('  git init')
console.log('  git add .')
console.log('  git commit -m "Dynamic Island for Windows"')
console.log(`  git remote add origin https://github.com/${user}/${repo}.git`)
console.log('  git push -u origin main')
