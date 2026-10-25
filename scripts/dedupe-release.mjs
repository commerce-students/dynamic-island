#!/usr/bin/env node
/**
 * Keeps exactly one GitHub release per tag.
 *
 * electron-builder occasionally creates a second, empty release for the same
 * tag while publishing (one gets the installer, the other the .blockmap). This
 * keeps whichever release actually carries the most bytes and deletes the rest.
 *
 * Runs after publishing in CI. Does nothing when there is only one release.
 */

const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
const repo = process.env.GITHUB_REPOSITORY
const tag = process.env.GITHUB_REF_NAME || process.env.GITHUB_REF?.replace('refs/tags/', '')

if (!token || !repo || !tag) {
  console.log('dedupe: missing token, repository or tag - skipping')
  process.exit(0)
}

const api = `https://api.github.com/repos/${repo}`
const headers = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'dynamic-island'
}

const response = await fetch(`${api}/releases?per_page=50`, { headers })
if (!response.ok) {
  console.log(`dedupe: could not list releases (${response.status}) - skipping`)
  process.exit(0)
}

const releases = await response.json()
const sameTag = releases.filter((release) => release.tag_name === tag)

if (sameTag.length < 2) {
  console.log(`dedupe: ${sameTag.length} release(s) for ${tag}, nothing to do`)
  process.exit(0)
}

const weight = (release) => (release.assets || []).reduce((sum, asset) => sum + (asset.size || 0), 0)
sameTag.sort((a, b) => weight(b) - weight(a))
const keep = sameTag[0]

for (const release of sameTag.slice(1)) {
  for (const asset of release.assets || []) {
    await fetch(`${api}/releases/assets/${asset.id}`, { method: 'DELETE', headers })
  }
  const deleted = await fetch(`${api}/releases/${release.id}`, { method: 'DELETE', headers })
  console.log(`dedupe: removed duplicate release ${release.id} (${deleted.status})`)
}

console.log(`dedupe: kept release ${keep.id} with ${(keep.assets || []).length} asset(s)`)
