'use strict'

/**
 * Spotlight, for Windows - without an indexer.
 *
 * Two sources, both cheap enough to rebuild in the background:
 *   apps  - every shortcut under the Start Menu (per-user and all-users), plus
 *           the UWP apps PowerShell can enumerate.
 *   files - a bounded walk of the folders you actually use, with the noisy
 *           ones skipped.
 *
 * Nothing here touches Electron, so all of it is testable with plain folders
 * in a temp directory.
 */

const fs = require('fs')
const path = require('path')

/** Folders that are never worth walking: build output, caches, system dirs. */
const SKIP_DIR = new Set([
  'node_modules', '.git', '.svn', '.hg', '__pycache__', 'venv', '.venv', 'env',
  'dist', 'build', 'out', 'target', 'obj', 'bin', '.next', '.nuxt', '.cache',
  '.gradle', '.idea', '.vscode', 'tmp', 'temp', 'cache', 'caches', 'appdata',
  '$recycle.bin', 'windows', 'winsxs', 'assembly', 'installer', 'logs',
  'crashdumps', 'packages', 'onedrivetemp', 'node_modules.nosync'
])

/** Files worth ignoring even when their folder is fine. */
const SKIP_FILE = /(^~\$|^\.|\.(tmp|temp|part|partial|crdownload|download|lnk\.tmp)$|desktop\.ini$|thumbs\.db$)/i

/** Shortcut extensions that make something an "app". */
const APP_EXT = new Set(['.lnk', '.url', '.appref-ms'])

function lower(value) {
  return String(value == null ? '' : value).toLowerCase()
}

/** The name without its extension, which is what a person recognises. */
function displayName(file) {
  const base = path.basename(file)
  return base.replace(/\.(lnk|url|appref-ms)$/i, '')
}

/**
 * Depth-limited, count-limited walk. Breadth first so a huge folder cannot
 * starve the shallow results that matter.
 */
function walkFiles(roots, { maxDepth = 4, maxFiles = 6000, skip = SKIP_DIR, onError = null } = {}) {
  const found = []
  const seen = new Set()

  for (const root of roots) {
    if (!root || found.length >= maxFiles) continue
    let stat
    try { stat = fs.statSync(root) } catch { continue }
    if (!stat.isDirectory()) continue

    const queue = [{ dir: root, depth: 0 }]
    while (queue.length && found.length < maxFiles) {
      const { dir, depth } = queue.shift()
      let entries
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch (err) {
        if (onError) onError(dir, err)
        continue
      }

      for (const entry of entries) {
        if (found.length >= maxFiles) break
        const full = path.join(dir, entry.name)
        if (seen.has(full)) continue

        if (entry.isDirectory()) {
          if (depth + 1 > maxDepth) continue
          if (skip.has(lower(entry.name))) continue
          queue.push({ dir: full, depth: depth + 1 })
          continue
        }
        if (!entry.isFile()) continue
        if (SKIP_FILE.test(entry.name)) continue
        seen.add(full)
        found.push({ path: full, name: displayName(full), depth: depth + 1 })
      }
    }
  }

  return found
}

/**
 * Start Menu shortcuts, deepest first is unnecessary - the folder depth is
 * kept only so the ranker can favour the top level.
 */
function collectApps(dirs, { maxDepth = 6, maxApps = 800 } = {}) {
  const files = walkFiles(dirs, {
    maxDepth,
    maxFiles: maxApps,
    skip: new Set(['node_modules', '.git'])
  })

  return files
    .filter((item) => APP_EXT.has(path.extname(item.path).toLowerCase()))
    .map((item) => ({
      kind: 'app',
      name: item.name,
      path: item.path,
      detail: path.dirname(item.path),
      depth: item.depth
    }))
}

/**
 * `Get-StartApps` is the only way to see Store apps: they have no shortcut on
 * disk. The runner is injected so this stays testable.
 */
function parseStartApps(output) {
  let parsed
  try { parsed = JSON.parse(output) } catch { return [] }
  const list = Array.isArray(parsed) ? parsed : []
  return list
    .filter((entry) => entry && entry.Name && entry.AppID)
    .map((entry) => ({
      kind: 'app',
      name: String(entry.Name).slice(0, 120),
      // Launch target understood by Explorer, not a path.
      launch: `shell:AppsFolder\\${entry.AppID}`,
      path: '',
      detail: 'Microsoft Store app',
      depth: 1,
      uwp: true
    }))
}

/** `gch` should find "Google Chrome": the letters, in order, not necessarily together. */
function isSubsequence(needle, haystack) {
  if (!needle) return true
  let index = 0
  for (const char of haystack) {
    if (char === needle[index]) index += 1
    if (index === needle.length) return true
  }
  return false
}

function wordStarts(name) {
  return String(name)
    .split(/[\s\-_.()[\]{}«»]+/)
    .filter(Boolean)
}

/**
 * The whole ranker. Higher wins; 0 means "no match at all".
 *
 * The shape of the numbers matters less than the order: exact, then prefix,
 * then a word starting with the query, then a word acronym, then anywhere in
 * the name, then anywhere in the path, then a loose subsequence.
 */
function score(item, query) {
  const q = lower(query).trim()
  if (!q) return 1

  const name = lower(item.name)
  const detail = lower(item.detail)
  let value = 0

  if (name === q) {
    value = 1000
  } else if (name.startsWith(q)) {
    value = 860 - Math.min(90, name.length - q.length)
  } else {
    const words = wordStarts(name)
    if (words.some((word) => word.startsWith(q))) {
      value = 720
    } else if (words.length > 1 && words.map((word) => word[0]).join('').startsWith(q)) {
      // Acronym: "vsc" -> Visual Studio Code.
      value = 640
    } else if (name.includes(q)) {
      value = 520 - Math.min(140, name.indexOf(q))
    } else if (detail.includes(q)) {
      value = 300
    } else if (q.length >= 2 && isSubsequence(q, name)) {
      value = 120
    } else {
      return 0
    }
  }

  // A launchable app is almost always what you meant.
  if (item.kind === 'app') value += 60
  // Shallower is more likely to be the real thing, not a sub-folder's copy.
  value -= Math.min(30, (item.depth || 0) * 3)
  // A short name that matches is a better answer than a long one.
  value -= Math.min(25, name.length / 12)
  return Math.round(value)
}

function search(items, query, limit = 24) {
  const q = lower(query).trim()
  const seen = new Set()
  const scored = []

  for (const item of items) {
    const key = item.uwp ? `uwp:${item.name}` : lower(item.path || item.name)
    if (seen.has(key)) continue
    seen.add(key)

    const value = score(item, q)
    if (value <= 0) continue
    scored.push({ item, value })
  }

  scored.sort((a, b) => {
    if (b.value !== a.value) return b.value - a.value
    if (a.item.name.length !== b.item.name.length) return a.item.name.length - b.item.name.length
    return a.item.name.localeCompare(b.item.name)
  })

  return scored.slice(0, Math.max(1, limit)).map((entry) => entry.item)
}

/**
 * Holds the two lists, rebuilds them when they are stale, and answers queries.
 * Everything is synchronous but fast: the walk is capped and the app scan is
 * a few hundred directory reads at most.
 */
function createIndex({
  appDirs = [],
  fileRoots = [],
  maxFiles = 6000,
  maxDepth = 4,
  ttlMs = 90 * 1000,
  now = Date.now,
  onError = null
} = {}) {
  let apps = []
  let files = []
  let builtAt = -1
  let building = false

  function build() {
    if (building) return
    building = true
    const started = now()
    try {
      apps = collectApps(appDirs)
    } catch (err) {
      if (onError) onError('apps', err)
      apps = []
    }
    try {
      files = walkFiles(fileRoots, { maxDepth, maxFiles, onError: (dir, err) => onError && onError(dir, err) })
        .filter((item) => !APP_EXT.has(path.extname(item.path).toLowerCase()))
        .map((item) => ({
          kind: 'file',
          name: item.name,
          path: item.path,
          detail: path.dirname(item.path),
          depth: item.depth
        }))
    } catch (err) {
      if (onError) onError('files', err)
      files = []
    }
    builtAt = now()
    building = false
    return now() - started
  }

  function refreshIfStale() {
    if (builtAt < 0 || now() - builtAt > ttlMs) build()
  }

  function query(text, limit = 24) {
    refreshIfStale()
    return search(apps.concat(files), text, limit)
  }

  /** Store apps arrive later than the disk scan, so they are merged in. */
  function mergeApps(extra) {
    if (!Array.isArray(extra) || !extra.length) return
    const known = new Set(apps.map((item) => lower(item.name)))
    apps = apps.concat(extra.filter((item) => !known.has(lower(item.name))))
  }

  return {
    build,
    query,
    mergeApps,
    get apps() { return apps },
    get files() { return files },
    stats: () => ({ apps: apps.length, files: files.length, builtAt })
  }
}

module.exports = {
  createIndex,
  walkFiles,
  collectApps,
  parseStartApps,
  score,
  search,
  displayName,
  isSubsequence,
  SKIP_DIR
}
