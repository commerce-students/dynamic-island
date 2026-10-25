#!/usr/bin/env node
/**
 * Assembles the bundled Python runtime that ships inside the installer.
 *
 * Why: the island talks to Windows through two Python sidecars (WinRT media
 * session + Core Audio levels). Most people installing a widget from GitHub
 * do not have Python, so we ship a private copy it can use.
 *
 * Result (all committed to the installer, not to git):
 *
 *   runtime/python/            portable CPython 3.12 (embeddable build)
 *   runtime/python/Lib/site-packages/   winrt, pycaw, comtypes
 *   runtime/bridge.py          media bridge
 *   runtime/volume.py          volume + peak bridge
 *
 * Usage:
 *   node scripts/prepare-runtime.mjs           # build if missing
 *   node scripts/prepare-runtime.mjs --force   # rebuild from scratch
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PY_VERSION = '3.12.10'
const PY_ZIP = `python-${PY_VERSION}-embed-amd64.zip`
const PY_URL = `https://www.python.org/ftp/python/${PY_VERSION}/${PY_ZIP}`

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cache = path.join(root, '.cache')
const out = path.join(root, 'runtime')
const pyDir = path.join(out, 'python')
const pyExe = path.join(pyDir, 'python.exe')
const sitePackages = path.join(pyDir, 'Lib', 'site-packages')
const force = process.argv.includes('--force')

const log = (msg) => console.log(`[runtime] ${msg}`)
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

function dirSize(dir) {
  if (!fs.existsSync(dir)) return 0
  return fs.readdirSync(dir, { withFileTypes: true }).reduce((sum, entry) => {
    const full = path.join(dir, entry.name)
    return sum + (entry.isDirectory() ? dirSize(full) : fs.statSync(full).size)
  }, 0)
}

async function download(url, dest) {
  log(`downloading ${path.basename(dest)}`)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText}`)
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()))
}

function unzip(zip, dest) {
  fs.rmSync(dest, { recursive: true, force: true })
  fs.mkdirSync(dest, { recursive: true })
  execFileSync('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dest}' -Force`
  ], { stdio: 'inherit' })
}

function patchPth() {
  const pth = path.join(pyDir, `python${PY_VERSION.split('.')[0]}${PY_VERSION.split('.')[1]}._pth`)
  if (!fs.existsSync(pth)) throw new Error(`missing ${pth}`)
  // "." then our local packages, then enable site so normal imports work.
  fs.writeFileSync(pth, ['python312.zip', '.', 'Lib\\site-packages', 'import site', ''].join('\r\n'))
}

function installPackages() {
  const python = process.env.PYTHON || 'python'
  log('installing sidecar dependencies (this takes a minute)')
  fs.mkdirSync(sitePackages, { recursive: true })
  execFileSync(python, [
    '-m', 'pip', 'install',
    '--disable-pip-version-check',
    '--no-warn-script-location',
    '--upgrade',
    '--target', sitePackages,
    '-r', path.join(root, 'requirements.txt')
  ], { stdio: 'inherit' })
}

function copyScripts() {
  for (const name of ['bridge.py', 'volume.py']) {
    fs.copyFileSync(path.join(root, 'src', name), path.join(out, name))
  }
}

function clean() {
  // pip leaves build leftovers that only bloat the installer.
  for (const junk of ['Scripts', 'bin', 'pywin32_system32']) {
    fs.rmSync(path.join(sitePackages, junk), { recursive: true, force: true })
  }
  const drop = (dir) => {
    if (!fs.existsSync(dir)) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === '__pycache__' || entry.name === 'tests' || entry.name === 'test') {
          fs.rmSync(full, { recursive: true, force: true })
        } else drop(full)
      }
    }
  }
  drop(sitePackages)
}

async function main() {
  if (fs.existsSync(pyExe) && !force) {
    log(`runtime already present (${mb(dirSize(out))}) - use --force to rebuild`)
    copyScripts()
    return
  }

  fs.mkdirSync(cache, { recursive: true })
  fs.mkdirSync(out, { recursive: true })

  const zip = path.join(cache, PY_ZIP)
  if (!fs.existsSync(zip)) await download(PY_URL, zip)

  log('extracting portable Python')
  unzip(zip, pyDir)
  patchPth()
  installPackages()
  clean()
  copyScripts()

  log(`done - runtime is ${mb(dirSize(out))}`)
}

main().catch((err) => {
  console.error(`[runtime] ${err.message}`)
  process.exit(1)
})
