/**
 * Builds the release body from the repository itself.
 *
 * `gh release create --generate-notes` looks only at *merged pull requests*
 * between two releases. This repository is pushed to directly, so GitHub
 * produced a body consisting of exactly one line — "Full Changelog: …" — for
 * v0.3.3. Nothing was wrong with the workflow; the generator had nothing to
 * read. Walking the commits between the previous tag and this one says what
 * actually changed on repositories that use PRs and on those that do not.
 *
 * Usage: node scripts/release-notes.mjs v0.3.3 > release-notes.md
 *
 * Reads: git history (previous `v*` tag, commits in between), package.json.
 * Writes: markdown on stdout. Nothing is written to the working tree.
 */

import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}

const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME ?? ''
if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
  process.stderr.write(`FAIL  "${tag}" is not a release tag of the form vX.Y.Z\n`)
  process.exit(1)
}

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

// repository.url is "git+https://github.com/owner/repo.git" in package.json.
const repo = pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, '')
const tarball = `${pkg.name.replace(/^@([^/]+)\//, '$1-')}-${pkg.version}.tgz`

let previous = ''
try {
  // stderr silenced: on a first release git exits non-zero with a message that
  // is expected here, and it would otherwise land in the workflow log as a
  // scary "fatal:" line right before a successful run.
  previous = execFileSync('git', ['describe', '--tags', '--abbrev=0', '--match', 'v*', `${tag}^`], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
} catch {
  // First release: there is no tag before this one. The whole history is the diff.
}

const range = previous ? `${previous}..${tag}` : tag
const commits = git('log', '--no-merges', '--pretty=format:%h %s', range)
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    const [hash, ...subject] = line.split(' ')
    return `- ${subject.join(' ')} ([${hash}](${repo}/commit/${hash}))`
  })

const compare = previous
  ? `**完整对比：** [\`${previous}...${tag}\`](${repo}/compare/${previous}...${tag})`
  : `**完整对比：** [\`${tag}\`](${repo}/commits/${tag})`

process.stdout.write(
  [
    commits.length
      ? `## 改了什么\n\n${commits.join('\n')}`
      : '本版没有新提交：与上一个版本内容相同，只是重新打包。',
    '',
    '## 装法',
    '',
    '```bash',
    `dsh plugin --profile desktop add ${pkg.name}@${pkg.version}`,
    '```',
    '',
    '装完重启一次应用。npm 上那份和这个 release 附件的 tgz 是**同一个文件**：发布时会把 npm 提供的包下载回来，和附件里的 `.sha256` 逐字节比过。',
    '',
    '不想走 npm 就按老办法装附件：下载下面的 tgz，在应用里 **插件 → 添加插件** 填它的绝对路径。',
    '',
    '```powershell',
    `Get-FileHash .\\${tarball} -Algorithm SHA256`,
    '```',
    '',
    '---',
    '',
    compare,
    '',
  ].join('\n'),
)
