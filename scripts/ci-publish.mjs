#!/usr/bin/env node
/**
 * Runs inside GitHub Actions only.
 *
 * electron-builder needs to know which repository to upload to. Instead of
 * hard-coding an owner in package.json (and breaking every fork), we read the
 * coordinates GitHub already gives every workflow run.
 *
 *   GITHUB_REPOSITORY = "owner/name"
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const slug = process.env.GITHUB_REPOSITORY

if (!slug || !slug.includes('/')) {
  console.error('GITHUB_REPOSITORY is not set - this script is for CI only')
  process.exit(1)
}

const [owner, repo] = slug.split('/')
const file = path.join(root, 'package.json')
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))

pkg.repository = { type: 'git', url: `https://github.com/${slug}.git` }
pkg.homepage = `https://github.com/${slug}`
pkg.bugs = { url: `https://github.com/${slug}/issues` }
pkg.build.publish = [{ provider: 'github', owner, repo, releaseType: 'release' }]

fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n')
console.log(`[ci] publishing to ${slug}`)
