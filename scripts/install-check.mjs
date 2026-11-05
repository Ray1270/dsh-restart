/**
 * Install the tarball the way a user does, into a profile that never existed
 * before, and then ask the real launcher what it composed.
 *
 * Every other check in this repository looks at the source tree. That is how a
 * release can be green three times and still be wrong: the tree had the plugin,
 * the package did not. `npm pack` decides what is shipped (`files`), and the
 * launcher decides whether a profile can load what was packed (the bundle patch,
 * the exports map, the client entry). Neither is visible in a source smoke test.
 *
 * So this does the boring user journey, for real:
 *
 *   1. `dsh plugin --profile <tmp> add <tarball>` — the same command the plugin
 *      manager runs, into a fresh $DSH_HOME that is deleted afterwards
 *   2. the profile records the dependency AND registers the bundle
 *   3. everything `files` promises is actually in the installed package, and
 *      `lib/helper.ps1` is there (restart reads it at runtime, from disk)
 *   4. `dsh --profile <tmp> --dump-config` composes the plugin with its config —
 *      i.e. the bundle patch inside the tarball is the one being read
 *
 * Usage:
 *   node scripts/install-check.mjs                       # packs the working tree
 *   node scripts/install-check.mjs --tarball <file.tgz>  # a release asset, e.g.
 *   node scripts/install-check.mjs --keep                # keep the temp home
 *
 * Needs `dsh` and `pnpm` on PATH (the launcher forwards to pnpm); exits 1 with a
 * plain sentence when one is missing, rather than skipping quietly.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
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
const tarballArg = argv[argv.indexOf('--tarball') + 1]
const givenTarball = argv.includes('--tarball') ? tarballArg : undefined
if (argv.includes('--tarball') && !givenTarball) fatal('--tarball needs a path')

/* --------------------------------------------------------- what we need here */

/*
 * On Windows `dsh` and `npm` are .cmd shims, which only a shell can start, and
 * Node's `shell: true` no longer accepts an argument list. So each invocation is
 * turned into one command line and handed to the platform shell directly.
 */
function quote(argument) {
  if (!/[ \t&|<>^"]/.test(argument)) return argument
  if (argument.includes('"')) throw new Error(`argument contains a quote: ${argument}`)
  return `"${argument}"`
}

function onPath(command) {
  const line = [process.platform === 'win32' ? 'where' : 'which', command].join(' ')
  const probe = process.platform === 'win32'
    ? spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', line], { encoding: 'utf8' })
    : spawnSync('/bin/sh', ['-c', line], { encoding: 'utf8' })
  return probe.status === 0
}

if (!onPath('dsh')) fatal('`dsh` is not on PATH — this check installs through the real launcher')
if (!onPath('pnpm')) fatal('`pnpm` is not on PATH — `dsh plugin` forwards to it')

const work = mkdtempSync(join(tmpdir(), 'dsh-restart-install-'))
const home = join(work, 'home')
const profile = 'installcheck'

function run(command, args, options = {}) {
  const line = [command, ...args.map(quote)].join(' ')
  const spawnOptions = {
    encoding: 'utf8',
    timeout: 300_000,
    ...options,
    env: { ...process.env, DSH_HOME: home, ...options.env },
  }
  const result = process.platform === 'win32'
    ? spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', line], spawnOptions)
    : spawnSync('/bin/sh', ['-c', line], spawnOptions)
  return { ...result, out: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

/* ------------------------------------------------------------- the tarball */

let tarball = givenTarball ? resolve(givenTarball) : ''
if (!givenTarball) {
  const packed = run('npm', ['pack', '--json', '--pack-destination', work], { cwd: root })
  if (packed.status !== 0) fatal(`npm pack failed:\n${packed.out}`)
  try {
    tarball = join(work, JSON.parse(packed.stdout)[0].filename)
  } catch {
    fatal(`could not read npm pack's output:\n${packed.stdout}`)
  }
}
check('tarball exists', existsSync(tarball), tarball)

/* ---------------------------------------------------- the user's install step */

const install = run('dsh', ['plugin', '--profile', profile, 'add', tarball])
check(
  'dsh plugin add installs the tarball',
  install.status === 0,
  install.status === 0 ? '' : (install.out.trim().split('\n').at(-1) ?? ''),
)
if (install.status !== 0) {
  process.stdout.write(`\n--- install output ---\n${install.out}\n`)
  if (!keep) rmSync(work, { recursive: true, force: true })
  process.exit(1)
}

const profileDir = join(home, 'profiles', profile)
const installed = join(profileDir, 'node_modules', ...pkg.name.split('/'))

let record = {}
try {
  record = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
} catch {}

check(
  'the profile records the dependency',
  Boolean(record.dependencies?.[pkg.name]) && record.dependencies[pkg.name].startsWith('file:'),
  record.dependencies?.[pkg.name] ?? 'missing',
)
check(
  'the profile registers the bundle',
  Array.isArray(record.dsh?.profile?.bundles) && record.dsh.profile.bundles.includes(pkg.name),
  (record.dsh?.profile?.bundles ?? []).join(' '),
)

/* --------------------------------------------- what the tarball claims to ship */

const missing = (pkg.files ?? []).filter((entry) => !existsSync(join(installed, entry)))
check(
  'every path in `files` is installed',
  missing.length === 0,
  missing.length ? `missing ${missing.join(', ')}` : (pkg.files ?? []).join(' '),
)

/* The restart reads this off disk at runtime; nothing else would notice it gone. */
check('lib/helper.ps1 is installed', existsSync(join(installed, 'lib', 'helper.ps1')))

/* The host half and the client half, by the paths package.json declares. */
const mainPath = join(installed, pkg.main ?? '')
check('the main entry is installed', existsSync(mainPath), pkg.main)
check('the client entry is installed', existsSync(join(installed, 'lib', 'client.js')))

let shipped = {}
try {
  shipped = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'))
} catch {}
check(
  'the installed package is this version',
  shipped.name === pkg.name && shipped.version === pkg.version,
  `${shipped.name}@${shipped.version}`,
)
check(
  'the installed client half is declared web',
  shipped.dsh?.client?.platform === 'web',
  String(shipped.dsh?.client?.platform),
)

/* -------------------------------------------- can the launcher compose it? */

const dump = run('dsh', ['--profile', profile, '--dump-config'], { cwd: work })
check('dsh --dump-config composes the profile', dump.status === 0)
check(
  'the composed tree contains the plugin',
  dump.status === 0 && dump.out.includes(`id: '${pkg.name}'`),
  dump.status === 0 && !dump.out.includes(`id: '${pkg.name}'`) ? 'not in the composed tree' : '',
)
check(
  'its config survives the round trip',
  dump.status === 0 && /enabled: true/.test(dump.out) && /pendingTtlMinutes: 30/.test(dump.out),
)

/* --------------------------------------------------------------- clean up */

if (keep) {
  process.stdout.write(`\nkept: ${work}\n  profile: ${profileDir}\n  tarball: ${tarball}\n`)
} else {
  rmSync(work, { recursive: true, force: true })
}

process.stdout.write(failed ? `\n${failed} failed\n` : '\nall passed\n')
process.exitCode = failed ? 1 : 0
