const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const patcher = require('../scripts/claudex-patcher.js');

const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const valid = { subjectSha: 'a'.repeat(40), profile: 'ci', requestId: '123e4567-e89b-12d3-a456-426614174000', currentVersion: '', currentSha256: '' };
const summary = { status: 'qualified', qualificationStatus: 'qualified', qualificationReason: null, recordSha256: 'e'.repeat(64), mismatchCount: 0, checkPatchSetMilliseconds: 1, peakRssBytes: 2, maxCheckMilliseconds: 60000, maxPeakRssBytes: 4 * 1024 ** 3, inputUnchanged: true, cleanup: { candidate: true, report: true, snapshots: true } };
const summaryText = JSON.stringify(summary);

function fixture(profile = 'release') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'patcher-test-'));
  const current = sha('current'); const commands = [];
  const env = { CLAUDEX_PATCHER_DEPLOY_KEY: 'ssh-private-key', CLAUDEX_PATCHER_REPOSITORY: 'git@private.invalid:owner/repository.git', GITHUB_SHA: 'b'.repeat(40), GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '1', RUNNER_TEMP: root, GITHUB_TOKEN: 'token', GITHUB_OUTPUT: '/private/output' };
  const runCommand = async (name, args, options) => {
    commands.push({ name, args, env: options.env });
    if (name === 'ssh-keyscan') return { code: 0, stdout: 'github-key\n', stderr: '' };
    if (name === 'ssh-keygen') return { code: 0, stdout: '256 SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU github.com (ED25519)\n', stderr: '' };
    if (name === 'git' && args[0] === 'init') { const tracked = path.join(args.at(-1), 'prebuilds/darwin-arm64/claudex-patcher.node'); fs.mkdirSync(path.dirname(tracked), { recursive: true }); fs.writeFileSync(tracked, 'addon'); }
    if (name === 'git' && args.at(-1) === 'HEAD') return { code: 0, stdout: 'a'.repeat(40), stderr: '' };
    if (name === 'curl') fs.writeFileSync(args[args.indexOf('--output') + 1], args.at(-1).includes('2.1.207') ? 'qualified' : 'current');
    if (name === 'mise' && args.at(-1).endsWith('rebuilt.node')) { const tracked = path.join(options.cwd, 'prebuilds/darwin-arm64/claudex-patcher.node'); fs.mkdirSync(path.dirname(tracked), { recursive: true }); fs.writeFileSync(tracked, 'addon'); fs.writeFileSync(args.at(-1), 'addon'); }
    if (name === 'mise' && (args.join(' ') === 'run verify:release' || args.join(' ') === 'run drift:check')) return { code: 0, stdout: `${summaryText}\n`, stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  return { commands, env, input: profile === 'ci' ? valid : { ...valid, profile, currentVersion: '2.1.208', currentSha256: current }, root, runCommand };
}

test('strictly validates dispatch inputs and canonical source-free proof', () => {
  assert.deepEqual(patcher.validateInputs(valid), valid);
  assert.throws(() => patcher.validateInputs({ ...valid, subjectSha: 'A'.repeat(40) }));
  assert.throws(() => patcher.validateInputs({ ...valid, profile: 'preview' }));
  assert.throws(() => patcher.validateInputs({ ...valid, profile: 'release' }));
  const proof = patcher.createProof({ ...valid, builderCommitSha: 'c'.repeat(40), trackedPrebuildSha256: 'd'.repeat(64), rebuiltPrebuildSha256: 'd'.repeat(64), gates: [{ name: 'mise run verify', status: 'passed' }], driftSummary: null, runId: 42, runAttempt: 1 });
  assert.equal(patcher.canonicalProof(proof), JSON.stringify(proof));
  assert.throws(() => patcher.canonicalProof({ ...proof, toolchain: { ...proof.toolchain, ldProjectVersion: 'bad' } }));
  assert.throws(() => patcher.canonicalProof({ ...proof, rebuiltPrebuildSha256: 'e'.repeat(64) }));
  assert.throws(() => patcher.canonicalProof({ ...proof, gates: [{ name: 'wrong', status: 'passed' }] }));
  assert.deepEqual(patcher.parseDriftSummary(`ignored\n${summaryText}`), summary);
  assert.throws(() => patcher.parseDriftSummary('{"status":"passed"}'));
  assert.throws(() => patcher.parseDriftSummary(JSON.stringify({ ...summary, cleanup: { candidate: true, report: true } })));
  assert.throws(() => patcher.parseDriftSummary(JSON.stringify({ ...summary, mismatchCount: -1 })));
  assert.throws(() => patcher.parseDriftSummary(JSON.stringify({ ...summary, qualificationReason: 'https://private.invalid' })));
  const releaseProof = patcher.createProof({ ...valid, profile: 'release', currentVersion: '2.1.208', currentSha256: 'f'.repeat(64), builderCommitSha: 'c'.repeat(40), trackedPrebuildSha256: 'd'.repeat(64), rebuiltPrebuildSha256: 'd'.repeat(64), gates: [{ name: 'mise run verify:release', status: 'passed' }], driftSummary: summary, runId: 42, runAttempt: 1 });
  for (const driftSummary of [{ ...releaseProof.driftSummary, maxCheckMilliseconds: 1 }, { ...releaseProof.driftSummary, maxPeakRssBytes: 1 }, { ...releaseProof.driftSummary, cleanup: { candidate: true, report: true } }, { ...releaseProof.driftSummary, qualificationReason: 'evidence-drift', mismatchCount: 0 }, { ...releaseProof.driftSummary, recordSha256: null }]) assert.throws(() => patcher.canonicalProof({ ...releaseProof, driftSummary }));
});

test('runs exact private command sequence with scrubbed environments and staged proof', async () => {
  const fx = fixture(); const output = []; const result = await patcher.run({ ...fx, inputs: fx.input, toolchainCheck: () => {}, hashFile: (file) => file.includes('qualified') ? '1397a062c6889675055e3314dd956376ac51262a7734ad9e819c26975d71547a' : file.includes('current') ? fx.input.currentSha256 : 'd'.repeat(64), emit: (line) => output.push(line) });
  assert.equal(result.ok, true, `${output.join()} ${result.code}`); assert.deepEqual(output, []);
  assert.deepEqual(fx.commands.map(({ name, args }) => [name, args]), [
    ['ssh-keyscan', ['-H', '-t', 'ed25519', 'github.com']], ['ssh-keygen', ['-lf', '-']], ['git', ['init', '--quiet', path.join(fx.root, 'checkout')]], ['git', ['-C', path.join(fx.root, 'checkout'), 'remote', 'add', 'origin', 'git@private.invalid:owner/repository.git']], ['git', ['-C', path.join(fx.root, 'checkout'), 'fetch', '--quiet', '--depth=1', 'origin', 'a'.repeat(40)]], ['git', ['-C', path.join(fx.root, 'checkout'), 'checkout', '--detach', '--quiet', 'FETCH_HEAD']], ['git', ['-C', path.join(fx.root, 'checkout'), 'rev-parse', 'HEAD']], ['mise', ['trust', '--yes', path.join(fx.root, 'checkout/mise.toml')]], ['mise', ['install', '--locked']], ['mise', ['exec', '--', 'bun', 'install', '--frozen-lockfile']], ['curl', ['--fail', '--silent', '--show-error', '--location', '--proto', '=https', '--proto-redir', '=https', '--max-redirs', '3', '--connect-timeout', '15', '--max-time', '120', '--max-filesize', '524288000', '--output', path.join(fx.root, 'target/qualified.claude'), 'https://downloads.claude.ai/claude-code-releases/2.1.207/darwin-arm64/claude']], ['curl', ['--fail', '--silent', '--show-error', '--location', '--proto', '=https', '--proto-redir', '=https', '--max-redirs', '3', '--connect-timeout', '15', '--max-time', '120', '--max-filesize', '524288000', '--output', path.join(fx.root, 'target/current.claude'), 'https://downloads.claude.ai/claude-code-releases/2.1.208/darwin-arm64/claude']], ['mise', ['run', 'verify:release']], ['mise', ['exec', '--', 'bun', 'scripts/build-native.ts', path.join(fx.root, 'target/rebuilt.node')]],
  ]);
  for (const command of fx.commands.slice(6)) for (const name of ['CLAUDEX_PATCHER_DEPLOY_KEY', 'CLAUDEX_PATCHER_REPOSITORY', 'GITHUB_TOKEN', 'GITHUB_OUTPUT']) assert.equal(command.env[name], undefined);
  const gate = fx.commands.find((item) => item.args.join(' ') === 'run verify:release'); assert.equal(gate.env.CLAUDEX_PATCHER_QUALIFIED_TARGET_EXECUTABLE, path.join(fx.root, 'target/qualified.claude')); assert.equal(gate.env.CLAUDEX_PATCHER_CURRENT_TARGET_EXECUTABLE, path.join(fx.root, 'target/current.claude')); assert.equal(gate.env.CLAUDEX_PATCHER_QUALIFIED_TARGET_VERSION, '2.1.207'); assert.equal(gate.env.CLAUDEX_PATCHER_CURRENT_TARGET_VERSION, '2.1.208');
  const proof = JSON.parse(fs.readFileSync(path.join(result.stage, 'proof.json'), 'utf8')); assert.deepEqual(proof.driftSummary, summary); assert.equal(proof.toolchain.developerDir, undefined);
  for (const item of ['checkout', 'target', 'logs', 'key', 'home', 'cargo']) assert.equal(fs.existsSync(path.join(fx.root, item)), false); fs.rmSync(fx.root, { recursive: true, force: true });
});

test('suppresses private diagnostics and cleans private state under failure', async () => {
  const fx = fixture('drift'); const output = []; fx.runCommand = async () => ({ code: 1, stdout: 'const secret = token; /private/source https://private.invalid AST Program', stderr: 'binary\x00' });
  const result = await patcher.run({ ...fx, inputs: fx.input, toolchainCheck: () => {}, emit: (line) => output.push(line) }); assert.equal(result.ok, false); assert.deepEqual(output, ['PATCHER_CHECKOUT_REJECTED']); assert.doesNotMatch(output.join('\n'), /private|secret|https|AST|binary/i);
  for (const item of ['checkout', 'target', 'logs', 'key', 'home', 'cargo', 'claudex-patcher-proof']) assert.equal(fs.existsSync(path.join(fx.root, item)), false); assert.equal(fx.env.CLAUDEX_PATCHER_DEPLOY_KEY, undefined); assert.equal(fx.env.CLAUDEX_PATCHER_REPOSITORY, undefined); fs.rmSync(fx.root, { recursive: true, force: true });
});

test('cleans all private state when mise trust fails', async () => {
  const fx = fixture(); const output = []; const original = fx.runCommand;
  fx.runCommand = async (name, args, options) => name === 'mise' && args[0] === 'trust' ? { code: 1, stdout: 'private config', stderr: 'private path' } : original(name, args, options);
  const result = await patcher.run({ ...fx, inputs: fx.input, toolchainCheck: () => {}, emit: (line) => output.push(line) });
  assert.equal(result.ok, false); assert.deepEqual(output, ['PATCHER_SETUP_REJECTED']); for (const item of ['checkout', 'target', 'logs', 'key', 'home', 'cargo']) assert.equal(fs.existsSync(path.join(fx.root, item)), false); fs.rmSync(fx.root, { recursive: true, force: true });
});

test('rejects an untrusted SSH host key without printing it', async () => {
  const fx = fixture(); const output = []; const original = fx.runCommand;
  fx.runCommand = async (name, args, options) => name === 'ssh-keygen' ? { code: 0, stdout: '256 SHA256:wrong github.com (ED25519)\\n', stderr: '' } : original(name, args, options);
  const result = await patcher.run({ ...fx, inputs: fx.input, toolchainCheck: () => {}, emit: (line) => output.push(line) });
  assert.equal(result.ok, false); assert.deepEqual(output, ['PATCHER_CHECKOUT_REJECTED']); assert.doesNotMatch(output.join('\\n'), /wrong|github/i); fs.rmSync(fx.root, { recursive: true, force: true });
});

test('workflow is manual-only, pinned, and keeps engine workflow frozen', () => {
  const root = path.resolve(__dirname, '..'); const workflow = fs.readFileSync(path.join(root, '.github/workflows/claudex-patcher.yml'), 'utf8');
  assert.match(workflow, /^on:\n  workflow_dispatch:/m); assert.doesNotMatch(workflow, /^  (push|pull_request|schedule):/m); assert.equal((workflow.match(/runs-on: macos-26/g) || []).length, 1); assert.match(workflow, /GIT_CONFIG_KEY_0: init\.defaultBranch\n  GIT_CONFIG_VALUE_0: main/); assert.match(workflow, /persist-credentials: false/); assert.equal((workflow.match(/upload-artifact@/g) || []).length, 1);
  for (const use of workflow.matchAll(/^\s+uses:\s+[^\s]+@([0-9a-f]{40}) # v/mg)) assert.equal(use[1].length, 40);
  assert.doesNotMatch(workflow, /ompex\/engine|git@github|https:\/\//);
  assert.equal(require('node:child_process').spawnSync('git', ['diff', '--exit-code', '--', '.github/workflows/build.yml'], { cwd: root }).status, 0);
});
