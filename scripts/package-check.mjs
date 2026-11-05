/**
 * Check the tarball, not the tree.
 *
 * Every other check in this repository reads the working copy. That is how a
 * release can look green and still be wrong: `npm pack` ships only what `files`
 * lists, and a path that exists in the tree need not exist in the package. The
 * published v0.3.3 line of accidents was the same shape — everything succeeded,
 * the thing users got was not what had been tested.
 *
 * So this unpacks the artifact and does two things with it:
 *
 *   1. everything package.json promises is really inside the tarball —
 *      `files`, `main`, every `exports` target, the bundle patch, and
 *      `lib/helper.ps1` (restart reads it off disk at runtime, so a missing
 *      file is a broken restart, not a broken import)
 *   2. the *packed* host and client halves run their own smoke tests: the test
 *      files are copied next to the extracted `lib/`, so `../lib/index.js` and
 *      `../lib/client.js` resolve to the shipped bytes
 *
 * No launcher, no pnpm, no network: this runs anywhere `node` and `tar` do, in
 * about a second, which is why it is the gate in `release.yml`. The fuller
 * check — install the tarball into a fresh profile and ask the launcher to
 * compose it — is `scripts/install-check.mjs`, run before tagging.
 *
 * Usage:
 *   node scripts/package-check.mjs                       # packs the working tree
 *   node scripts/package-check.mjs --tarball <file.tgz>  # a release asset
 *   node scripts/package-check.mjs --keep                # keep the unpacked tree
 */

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

let failed = 0
function check(name, ok, detail = '') {
  if (!ok) failed++
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}\n`)
}

function fatal(message) {
  process.stdout.write(`FAIL  ${message}\n`)
  process.exit(1)
}

/* ---------------------------------------------------------------- arguments */

const argv = process.argv.slice(2)
const keep = argv.includes('--keep')
const givenTarball = argv.includes('--tarball') ? argv[argv.indexOf('--tarball') + 1] : undefined
if (argv.includes('--tarball') && !givenTarball) fatal('--tarball needs a path')

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 300_000, ...options })
  return { ...result, out: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

/*
 * `npm` is a .cmd shim on Windows, which only a shell can start, and Node's
 * `shell: true` no longer takes an argument list. Everything else here is a real
 * executable and is spawned directly.
 */
function runNpm(args, options = {}) {
  if (process.platform !== 'win32') return run('npm', args, options)
  const line = ['npm', ...args].join(' ')
  const result = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', line], {
    encoding: 'utf8',
    timeout: 300_000,
    ...options,
  })
  return { ...result, out: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

const work = mkdtempSync(join(tmpdir(), 'dsh-restart-package-'))

/* --------------------------------------------------------------- the tarball */

let tarball = givenTarball ? resolve(givenTarball) : ''
if (!givenTarball) {
  const packed = runNpm(['pack', '--json', '--pack-destination', work], { cwd: root })
  if (packed.status !== 0) fatal(`npm pack failed:\n${packed.out}`)
  try {
    tarball = join(work, JSON.parse(packed.stdout)[0].filename)
  } catch {
    fatal(`could not read npm pack's output:\n${packed.stdout}`)
  }
}
check('tarball exists', existsSync(tarball), tarball)

/*
 * tar is always given a relative name from a working directory that holds the
 * archive: GNU tar reads `C:\...` as a remote host:path. Copying the tarball into
 * the scratch directory is what makes both platforms agree.
 */
const localTarball = join(work, basename(tarball))
if (resolve(tarball) !== resolve(localTarball)) copyFileSync(tarball, localTarball)

const listing = run('tar', ['-tzf', basename(localTarball)], { cwd: work })
check('the tarball lists', listing.status === 0)

/* A package is data from outside the repository; ../ in a path is how a tarball
 * overwrites something it was never given. npm refuses these itself, but the
 * check is one line and this file is the place that looks. */
const entries = listing.out.split('\n').filter(Boolean)
const escaping = entries.filter(
  (entry) => entry.startsWith('/') || entry.split('/').includes('..') || /^[a-zA-Z]:/.test(entry),
)
check('no absolute or escaping paths', escaping.length === 0, escaping.slice(0, 3).join(', '))

const unpacked = join(work, 'unpacked')
mkdirSync(unpacked, { recursive: true })
const extracted = run('tar', ['-xzf', basename(localTarball), '-C', 'unpacked'], { cwd: work })
check('the tarball extracts', extracted.status === 0, extracted.status === 0 ? '' : extracted.out.trim())

const shippedDir = join(unpacked, 'package')
if (!existsSync(join(shippedDir, 'package.json'))) fatal('the tarball has no package/package.json')

const shipped = JSON.parse(readFileSync(join(shippedDir, 'package.json'), 'utf8'))

/* ------------------------------------------------ what the manifest promises */

check(
  'the packaged manifest is this package',
  shipped.name === pkg.name && shipped.version === pkg.version,
  `${shipped.name}@${shipped.version}`,
)

const missing = (shipped.files ?? []).filter((entry) => !existsSync(join(shippedDir, entry)))
check(
  'every path in `files` is in the tarball',
  missing.length === 0,
  missing.length ? `missing ${missing.join(', ')}` : (shipped.files ?? []).join(' '),
)

/* Flatten `exports`, which mixes strings and condition objects. */
const exportTargets = Object.values(shipped.exports ?? {}).flatMap((value) =>
  typeof value === 'string' ? [value] : Object.values(value).filter((v) => typeof v === 'string'),
)
const missingExports = exportTargets.filter((target) => !existsSync(join(shippedDir, target)))
check(
  'every `exports` target is in the tarball',
  missingExports.length === 0,
  missingExports.length ? `missing ${missingExports.join(', ')}` : exportTargets.join(' '),
)

check('the main entry is in the tarball', existsSync(join(shippedDir, shipped.main ?? '')), shipped.main)

const patch = shipped.dsh?.bundle?.patch
check('the bundle patch is in the tarball', Boolean(patch) && existsSync(join(shippedDir, patch)), patch ?? 'none declared')

check(
  'the client half is declared web',
  shipped.dsh?.client?.platform === 'web',
  String(shipped.dsh?.client?.platform),
)

/* Restart resolves this by path at runtime. Nothing imports it, so nothing else
 * in this repository would notice it going missing. */
check('lib/helper.ps1 is in the tarball', existsSync(join(shippedDir, 'lib', 'helper.ps1')))

check('no node_modules shipped', !existsSync(join(shippedDir, 'node_modules')))
check('no .git shipped', !existsSync(join(shippedDir, '.git')))

/* ------------------------------------ the shipped bytes run their own tests */

function runShippedTest(file, half) {
  mkdirSync(join(shippedDir, 'scripts'), { recursive: true })
  copyFileSync(join(root, 'scripts', file), join(shippedDir, 'scripts', file))
  const result = run(process.execPath, [join('scripts', file)], { cwd: shippedDir })
  const lines = result.out.trim().split('\n').filter(Boolean)
  const summary = lines.filter((line) => line.includes('checks passed')).at(-1) ?? lines.at(-1) ?? ''
  check(`the packed ${half} half passes its own smoke test`, result.status === 0, summary)
  if (result.status !== 0) process.stdout.write(`${result.out}\n`)
}

runShippedTest('smoke-host.mjs', 'host')
runShippedTest('smoke-client.mjs', 'client')

/* --------------------------------------------------------------- clean up */

if (keep) {
  process.stdout.write(`\nkept: ${unpacked}\n  tarball: ${tarball}\n`)
} else {
  rmSync(work, { recursive: true, force: true })
}

process.stdout.write(failed ? `\n${failed} failed\n` : '\nall passed\n')
process.exitCode = failed ? 1 : 0
