// `make publish`, `make version-minor`, `make version-major`.
//
//   node scripts/release.mjs publish        bump the patch, commit, tag, push
//   node scripts/release.mjs bump minor     start the next minor (or major)
//
// A release is a pushed v* tag: .github/workflows/release.yml checks, builds
// and publishes it to npm. So `publish` does not publish anything itself. It
// writes the tag that the workflow waits for and pushes it with the commit
// that names the same version.
//
// The patch number belongs to the machine; the major and minor belong to a
// person. So `publish` bumps the patch only when the version in package.json
// is already released: its tag exists, or npm already has it. A version with
// no release was set by `bump` to start a new minor or major. `publish`
// releases that version as it is, so 0.2.0 goes out and 0.2.1 comes next.
//
// "npm version" runs the "version" lifecycle script, which copies the version
// into builtin/*/hcm.yaml. So the release commit includes builtin/.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const RELEASE_BRANCH = 'main';
const WORKFLOW = 'release.yml';
const FILES = ['package.json', 'package-lock.json', 'builtin'];

const fail = (message) => {
  console.error(`release: ${message}`);
  process.exit(1);
};

// On Windows npm is npm.cmd, and only a shell can start it. So npm goes as one
// command string. Its arguments are a version and fixed words, so the shell
// has nothing to change. git starts directly.
const run = (command, args, { check = true, quiet = false } = {}) => {
  const viaShell = command === 'npm';
  const result = spawnSync(viaShell ? `npm ${args.join(' ')}` : command, viaShell ? [] : args, {
    shell: viaShell,
    encoding: 'utf8',
    stdio: ['ignore', quiet ? 'pipe' : 'inherit', quiet ? 'pipe' : 'inherit'],
  });
  if (check && result.status !== 0) {
    fail(`${command} ${args.join(' ')} failed${quiet ? `:\n${result.stderr.trim()}` : ''}`);
  }
  return result;
};
const git = (...args) => run('git', args, { quiet: true }).stdout.trim();

const tagFor = (version) => `v${version}`;
const tagExists = (version) =>
  run('git', ['rev-parse', '-q', '--verify', `refs/tags/${tagFor(version)}`], { check: false, quiet: true }).status === 0;

const readPackage = () => JSON.parse(readFileSync('package.json', 'utf8'));

// npm prints the version when the registry has it, and nothing (or an E404
// for a package that does not exist yet) when it does not.
const onNpm = (name, version) =>
  run('npm', ['view', `${name}@${version}`, 'version'], { check: false, quiet: true }).stdout.trim() === version;

const next = (version, part) => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) fail(`package.json version ${version} is not MAJOR.MINOR.PATCH`);
  const [major, minor, patch] = match.slice(1).map(Number);
  if (part === 'major') return `${major + 1}.0.0`;
  if (part === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
};

// package.json, package-lock.json and the built-in manifests move together,
// and nothing else moves.
const setVersion = (version, message) => {
  run('npm', ['version', version, '--no-git-tag-version', '--allow-same-version'], { quiet: true });
  run('git', ['add', '--', ...FILES]);
  run('git', ['commit', '-q', '-m', message, '--', ...FILES]);
};

const requireClean = () => {
  if (git('status', '--porcelain')) fail('the working tree has uncommitted changes. Commit or stash them first.');
};

// The repository page on GitHub, from an ssh or https remote URL.
const repoUrl = (remote) => {
  const url = git('remote', 'get-url', remote);
  const match = /github\.com[:/](.+?)(?:\.git)?$/.exec(url);
  return match ? `https://github.com/${match[1]}` : undefined;
};

const publish = () => {
  requireClean();
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (branch !== RELEASE_BRANCH) fail(`releases are made from ${RELEASE_BRANCH}, and this is ${branch}.`);
  const upstream = run('git', ['rev-parse', '--abbrev-ref', '@{u}'], { check: false, quiet: true });
  if (upstream.status !== 0) fail(`${branch} has no upstream branch to push to.`);
  const remote = upstream.stdout.trim().split('/')[0];

  console.log(`Fetching ${remote}...`);
  run('git', ['fetch', '-q', '--tags', remote]);
  if (git('rev-list', '--count', 'HEAD..@{u}') !== '0') {
    fail(`${branch} is behind ${upstream.stdout.trim()}. Pull first.`);
  }

  const { name, version: current } = readPackage();
  const bumped = tagExists(current) || onNpm(name, current);
  const version = bumped ? next(current, 'patch') : current;
  const tag = tagFor(version);
  if (tagExists(version)) fail(`tag ${tag} already exists.`);
  if (onNpm(name, version)) fail(`npm already has ${name}@${version}.`);

  if (bumped) {
    console.log(`Bumping ${current} -> ${version}`);
    setVersion(version, `Release ${version}`);
  } else {
    console.log(`Releasing ${version} as set in package.json (it has no release yet)`);
  }
  run('git', ['tag', '-a', tag, '-m', `${name} ${version}`]);

  // Atomic: the commit and the tag land together or not at all. If the remote
  // refuses the push, this undoes the local commit and tag, so a second run is
  // safe.
  console.log(`Pushing ${branch} and tag ${tag} to ${remote}...`);
  const pushed = run('git', ['push', '--atomic', remote, `HEAD:refs/heads/${branch}`, `refs/tags/${tag}`], { check: false });
  if (pushed.status !== 0) {
    run('git', ['tag', '-d', tag], { quiet: true });
    if (bumped) run('git', ['reset', '-q', '--keep', 'HEAD~1']);
    fail('the remote refused the push. The local commit and tag are undone.');
  }

  const repo = repoUrl(remote);
  console.log(`\nPushed ${tag}. The Release workflow checks, builds and publishes it to npm.`);
  if (repo) console.log(`Follow it at ${repo}/actions/workflows/${WORKFLOW}`);
};

const bump = (part) => {
  if (part !== 'minor' && part !== 'major') fail('bump takes minor or major. make publish bumps the patch.');
  requireClean();
  const version = next(readPackage().version, part);
  setVersion(version, `Start ${version}`);
  console.log(`package.json is now ${version}, committed and not tagged. make publish releases it.`);
};

const [command, arg] = process.argv.slice(2);
if (command === 'publish') publish();
else if (command === 'bump') bump(arg);
else fail('usage: node scripts/release.mjs publish | bump minor|major');
