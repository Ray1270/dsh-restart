/**
 * Guard for the one mistake a tag-driven release can still make: tagging a
 * version that is not the version in package.json.
 *
 * `release.yml` packs the tarball named after package.json and attaches it to a
 * release named after the tag. If those two disagree, everything still succeeds
 * — and the release quietly advertises one version while shipping another. So
 * the tag is compared to package.json before anything is packed or tested, and
 * the mismatch is reported with both numbers instead of one confusing 404 later.
 *
 * Usage:
 *   node scripts/release-check.mjs v0.3.3     # the tag being pushed
 *   node scripts/release-check.mjs            # falls back to $GITHUB_REF_NAME,
 *                                             # which is the tag inside Actions
 *
 * Exit code 0 when the tag names the packaged version, 1 otherwise.
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function fail(message) {
  process.stdout.write(`FAIL  ${message}\n`)
  process.exitCode = 1
}

const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME ?? ''

if (!tag) {
  fail('no tag given — pass one (node scripts/release-check.mjs v0.3.3) or run inside Actions')
  process.exit()
}

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

/*
 * Only plain `vX.Y.Z` tags are released. A prerelease suffix is deliberately
 * rejected rather than parsed: `npm pack` would name the file after the
 * version in package.json, which carries no suffix, so a `v0.3.3-rc.1` tag
 * could never match it anyway.
 */
const match = /^v(\d+\.\d+\.\d+)$/.exec(tag)
if (!match) {
  fail(`"${tag}" is not a release tag of the form vX.Y.Z`)
  process.exit()
}

const tagged = match[1]

if (tagged !== pkg.version) {
  // `npm pack` rewrites the scope into the filename: @ray1270/dsh-restart@1.2.3
  // becomes ray1270-dsh-restart-1.2.3.tgz.
  const tarball = `${pkg.name.replace(/^@([^/]+)\//, '$1-')}-${pkg.version}.tgz`
  fail(`tag ${tag} does not match package.json version ${pkg.version}`)
  process.stdout.write(
    `      the tarball would be named ${tarball} but the release would be called ${tag}\n` +
      `      bump package.json to ${tagged}, commit, then tag — or tag v${pkg.version}\n`,
  )
  process.exit()
}

process.stdout.write(`PASS  tag ${tag} names the packaged version ${pkg.name}@${pkg.version}\n`)
