'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  createIndex,
  walkFiles,
  collectApps,
  parseStartApps,
  score,
  search,
  isSubsequence
} = require('../src/lib/search')

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'di-search-'))
}

function touch(dir, ...names) {
  for (const name of names) {
    const full = path.join(dir, name)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, 'x')
  }
}

const app = (name, depth = 1) => ({ kind: 'app', name, path: `C:\\Apps\\${name}.lnk`, detail: 'C:\\Apps', depth })
const file = (name, dir, depth = 2) => ({ kind: 'file', name, path: `${dir}\\${name}`, detail: dir, depth })

/* ------------------------------------------------------------------ *
 * ranking
 * ------------------------------------------------------------------ */

test('an exact name beats a prefix, which beats a substring', () => {
  const exact = score(app('Code'), 'code')
  const prefix = score(app('Code Writer'), 'code')
  const inside = score(app('Visual Studio Code'), 'code')
  assert.ok(exact > prefix, `${exact} > ${prefix}`)
  assert.ok(prefix > inside, `${prefix} > ${inside}`)
})

test('a word start beats a substring in the middle', () => {
  const word = score(app('Google Chrome'), 'chr')
  const midWord = score(app('Microchrome'), 'chr')
  assert.ok(word > 0)
  assert.ok(midWord > 0)
  assert.ok(word > midWord, `${word} > ${midWord}`)
})

test('an acronym finds multi-word apps', () => {
  const value = score(app('Visual Studio Code'), 'vsc')
  assert.ok(value > 0, 'vsc should match Visual Studio Code')
  assert.equal(score(app('Visual Studio Code'), 'zzz'), 0)
})

test('letters in order are a weak last resort', () => {
  assert.equal(isSubsequence('gch', 'google chrome'), true)
  assert.equal(isSubsequence('hcg', 'google chrome'), false)
  const loose = score(app('Google Chrome'), 'gch')
  assert.ok(loose > 0)
  assert.ok(loose < score(app('Google Chrome'), 'goo'))
})

test('apps outrank files on the same name', () => {
  const a = score(app('Notes'), 'notes')
  const f = score(file('Notes', 'C:\\Users\\me\\Desktop'), 'notes')
  assert.ok(a > f)
})

test('an empty query matches everything equally', () => {
  assert.equal(score(app('Anything'), ''), 1)
  assert.equal(score(file('x', 'C:\\'), '   '), 1)
})

test('search returns nothing for a query that matches nothing', () => {
  const items = [app('Calculator'), app('Paint')]
  assert.deepEqual(search(items, 'qqqq'), [])
})

test('search deduplicates the same app reached twice', () => {
  const items = [app('Steam'), app('Steam')]
  assert.equal(search(items, 'steam').length, 1)
})

test('search respects its limit', () => {
  const items = Array.from({ length: 40 }, (_, i) => app(`App ${i}`))
  assert.equal(search(items, 'app', 8).length, 8)
})

test('search prefers the shorter name when the score ties', () => {
  const results = search([app('Zoom Meetings Extra'), app('Zoom')], 'zoom')
  assert.equal(results[0].name, 'Zoom')
})

/* ------------------------------------------------------------------ *
 * walking
 * ------------------------------------------------------------------ */

test('the walk finds nested files but not past its depth', () => {
  const root = tempDir()
  touch(root, 'a.txt', 'one/b.txt', 'one/two/c.txt', 'one/two/three/four/d.txt')

  const shallow = walkFiles([root], { maxDepth: 1 })
  assert.deepEqual(shallow.map((item) => item.name).sort(), ['a.txt', 'b.txt'])

  const deep = walkFiles([root], { maxDepth: 5 })
  assert.deepEqual(deep.map((item) => item.name).sort(), ['a.txt', 'b.txt', 'c.txt', 'd.txt'])
})

test('the walk skips build output and junk files', () => {
  const root = tempDir()
  touch(root,
    'keep.txt',
    'node_modules/dependency/index.js',
    '.git/config',
    'report.part',
    '~$locked.docx',
    'Thumbs.db',
    'desktop.ini'
  )

  const names = walkFiles([root], { maxDepth: 5 }).map((item) => item.name).sort()
  assert.deepEqual(names, ['keep.txt'])
})

test('the walk respects its file cap', () => {
  const root = tempDir()
  for (let i = 0; i < 30; i += 1) touch(root, `file-${i}.txt`)
  assert.equal(walkFiles([root], { maxDepth: 2, maxFiles: 10 }).length, 10)
})

test('a missing root is not fatal', () => {
  const root = tempDir()
  const found = walkFiles([path.join(root, 'nope'), root], { maxDepth: 1 })
  assert.deepEqual(found, [])
})

test('the walk does not follow a folder into itself twice', () => {
  const root = tempDir()
  touch(root, 'a.txt')
  const first = walkFiles([root, root], { maxDepth: 2 })
  assert.equal(first.length, 1)
})

/* ------------------------------------------------------------------ *
 * apps
 * ------------------------------------------------------------------ */

test('shortcuts become apps with a readable name', () => {
  const root = tempDir()
  touch(root, 'Google Chrome.lnk', 'Notion.url', 'readme.txt', 'Utilities/Terminal.lnk')

  const apps = collectApps([root])
  assert.deepEqual(apps.map((item) => item.name).sort(), ['Google Chrome', 'Notion', 'Terminal'])
  assert.ok(apps.every((item) => item.kind === 'app'))
})

test('Get-StartApps output becomes launchable store apps', () => {
  const apps = parseStartApps(JSON.stringify([
    { Name: 'Calculator', AppID: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App' },
    { Name: '', AppID: 'ignored' }
  ]))

  assert.equal(apps.length, 1)
  assert.equal(apps[0].name, 'Calculator')
  assert.equal(apps[0].uwp, true)
  assert.match(apps[0].launch, /^shell:AppsFolder\\/)
})

test('junk from PowerShell is ignored rather than thrown', () => {
  assert.deepEqual(parseStartApps('not json'), [])
  assert.deepEqual(parseStartApps('null'), [])
  assert.deepEqual(parseStartApps('{"Name":"x"}'), [])
})

/* ------------------------------------------------------------------ *
 * the index
 * ------------------------------------------------------------------ */

test('the index combines apps and files', () => {
  const apps = tempDir()
  const docs = tempDir()
  touch(apps, 'Spotify.lnk')
  touch(docs, 'Budget.xlsx')

  const index = createIndex({ appDirs: [apps], fileRoots: [docs] })
  index.build()

  assert.deepEqual(index.stats().apps, 1)
  assert.deepEqual(index.stats().files, 1)
  assert.equal(index.query('spot').length, 1)
  assert.equal(index.query('budget')[0].kind, 'file')
})

test('the index rebuilds when it goes stale', () => {
  const apps = tempDir()
  touch(apps, 'One.lnk')

  let clock = 0
  const index = createIndex({ appDirs: [apps], fileRoots: [], ttlMs: 1000, now: () => clock })
  index.build()
  assert.equal(index.stats().apps, 1)

  touch(apps, 'Two.lnk')
  clock = 500
  assert.equal(index.query('two').length, 0, 'still inside the ttl')
  clock = 5000
  assert.equal(index.query('two').length, 1, 'rebuilt once stale')
})

test('store apps merge without duplicating a shortcut', () => {
  const apps = tempDir()
  touch(apps, 'Calculator.lnk')

  const index = createIndex({ appDirs: [apps], fileRoots: [] })
  index.build()
  index.mergeApps(parseStartApps(JSON.stringify([
    { Name: 'Calculator', AppID: 'a!App' },
    { Name: 'Clock', AppID: 'b!App' }
  ])))

  const results = index.query('cal')
  assert.equal(results.length, 1, 'the disk shortcut wins')
  assert.equal(index.query('clock').length, 1)
})

test('an unreadable folder does not break the index', () => {
  const index = createIndex({ appDirs: [path.join(tempDir(), 'missing')], fileRoots: [] })
  index.build()
  assert.deepEqual(index.query('anything'), [])
})
