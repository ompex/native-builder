#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const QUALIFIED = { sha256: '1397a062c6889675055e3314dd956376ac51262a7734ad9e819c26975d71547a', version: '2.1.207' };
const PROOF_KEYS = ['builderCommitSha', 'driftSummary', 'gates', 'officialTargets', 'profile', 'rebuiltPrebuildSha256', 'requestId', 'result', 'runAttempt', 'runId', 'subjectCommitSha', 'target', 'toolchain', 'trackedPrebuildSha256'];
const GATES = { ci: ['mise run verify'], release: ['mise run verify:release'], drift: ['mise run check:native-artifact', 'mise run drift:check'] };
const SECRET_NAMES = ['CLAUDEX_PATCHER_DEPLOY_KEY', 'CLAUDEX_PATCHER_REPOSITORY', 'GITHUB_TOKEN', 'GH_TOKEN', 'ACTIONS_RUNTIME_TOKEN', 'ACTIONS_RESULTS_URL', 'ACTIONS_RUNTIME_URL', 'ACTIONS_CACHE_URL', 'GITHUB_ENV', 'GITHUB_OUTPUT', 'GITHUB_PATH', 'GITHUB_STEP_SUMMARY'];

function reject(code) { const error = new Error(code); error.code = code; throw error; }
function version(value) { return /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/.test(value); }
function sha(value, length) { return new RegExp(`^[0-9a-f]{${length}}$`).test(value || ''); }
function validateInputs(input) {
  const value = { ...input };
  if (!sha(value.subjectSha, 40) || !['ci', 'release', 'drift'].includes(value.profile) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.requestId || '')) reject('input');
  if (value.profile === 'ci' ? Boolean(value.currentVersion || value.currentSha256) : !version(value.currentVersion || '') || !sha(value.currentSha256, 64)) reject('input');
  return value;
}
function officialTargets(input) {
  validateInputs(input);
  if (input.profile === 'ci') return [];
  const current = { sha256: input.currentSha256, version: input.currentVersion };
  return input.profile === 'release' ? [QUALIFIED, current] : [current];
}
function officialUrl(target) { return `https://downloads.claude.ai/claude-code-releases/${target.version}/darwin-arm64/claude`; }
function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') { if (!Number.isFinite(value)) reject('proof'); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (!value || typeof value !== 'object') reject('proof');
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
function safe(value) {
  if (typeof value === 'string' && (/[\r\n]|https?:\/\/|(?:^|\/)(?:Users|home|private)\/|ssh-|token|secret|password|authorization|\b(?:Program|Identifier|AST)\b/i.test(value))) reject('proof');
  if (Array.isArray(value)) value.forEach(safe);
  if (value && typeof value === 'object') Object.entries(value).forEach(([key, item]) => { if (/token|secret|credential|source|snippet|diagnostic|path|url/i.test(key)) reject('proof'); safe(item); });
}
function validateDriftSummary(parsed, ordered) {
  const keys = ['status', 'qualificationStatus', 'qualificationReason', 'recordSha256', 'mismatchCount', 'checkPatchSetMilliseconds', 'peakRssBytes', 'maxCheckMilliseconds', 'maxPeakRssBytes', 'inputUnchanged', 'cleanup'];
  const number = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const relation = parsed?.status === 'qualified' ? parsed.qualificationReason === null && sha(parsed.recordSha256, 64) && parsed.mismatchCount === 0 : parsed?.qualificationReason === 'unknown-version' ? parsed.recordSha256 === null && parsed.mismatchCount === 0 : parsed?.qualificationReason === 'evidence-drift' ? sha(parsed.recordSha256, 64) && parsed.mismatchCount > 0 : false;
  if (!parsed || Array.isArray(parsed) || Object.keys(parsed).sort().join(',') !== [...keys].sort().join(',') || (ordered && Object.keys(parsed).join(',') !== keys.join(',')) || canonical(parsed.cleanup) !== '{"candidate":true,"report":true,"snapshots":true}' || parsed.inputUnchanged !== true || parsed.maxCheckMilliseconds !== 60000 || parsed.maxPeakRssBytes !== 4 * 1024 ** 3 || !Number.isSafeInteger(parsed.mismatchCount) || parsed.mismatchCount < 0 || !number(parsed.checkPatchSetMilliseconds) || !number(parsed.peakRssBytes) || parsed.checkPatchSetMilliseconds > parsed.maxCheckMilliseconds || parsed.peakRssBytes > parsed.maxPeakRssBytes || !['qualified', 'unqualified'].includes(parsed.status) || parsed.qualificationStatus !== parsed.status || !relation) reject('drift');
  safe(parsed); return parsed;
}
function parseDriftSummary(output) {
  const final = output.trimEnd().split('\n').at(-1); let parsed;
  try { parsed = JSON.parse(final); } catch { reject('drift'); }
  if (JSON.stringify(parsed) !== final) reject('drift');
  return validateDriftSummary(parsed, true);
}
function expectedGates(profile) { return GATES[profile].map((name) => ({ name, status: 'passed' })); }
function createProof(input) {
  const driftSummary = input.profile === 'ci' ? null : JSON.parse(canonical(parseDriftSummary(JSON.stringify(input.driftSummary))));
  return {
    builderCommitSha: input.builderCommitSha, driftSummary,
    gates: input.gates, officialTargets: officialTargets(input), profile: input.profile,
    rebuiltPrebuildSha256: input.rebuiltPrebuildSha256, requestId: input.requestId, result: 'passed',
    runAttempt: input.runAttempt, runId: input.runId, subjectCommitSha: input.subjectSha,
    target: { arch: 'arm64', os: 'darwin' }, toolchain: { ldProjectVersion: '1267', sdk: '26.5', xcodeBuild: '17F113', xcodeVersion: '26.6' },
    trackedPrebuildSha256: input.trackedPrebuildSha256,
  };
}
function canonicalProof(proof) {
  if (Object.keys(proof).join(',') !== PROOF_KEYS.join(',') || proof.result !== 'passed' || !sha(proof.builderCommitSha, 40) || !sha(proof.subjectCommitSha, 40) || !sha(proof.trackedPrebuildSha256, 64) || proof.rebuiltPrebuildSha256 !== proof.trackedPrebuildSha256 || canonical(proof.gates) !== canonical(expectedGates(proof.profile)) || canonical(proof.officialTargets) !== canonical(officialTargets({ subjectSha: proof.subjectCommitSha, profile: proof.profile, requestId: proof.requestId, currentVersion: proof.officialTargets.at(-1)?.version || '', currentSha256: proof.officialTargets.at(-1)?.sha256 || '' })) || proof.target?.arch !== 'arm64' || proof.target?.os !== 'darwin' || canonical(proof.toolchain) !== canonical({ ldProjectVersion: '1267', sdk: '26.5', xcodeBuild: '17F113', xcodeVersion: '26.6' }) || !Number.isSafeInteger(proof.runId) || proof.runId < 1 || !Number.isSafeInteger(proof.runAttempt) || proof.runAttempt < 1 || (proof.profile === 'ci') !== (proof.driftSummary === null)) reject('proof');
  if (proof.driftSummary !== null) validateDriftSummary(proof.driftSummary, false);
  safe(proof);
  const json = canonical(proof);
  if (json !== JSON.stringify(proof)) reject('proof');
  return json;
}
function scrubEnvironment(env) { const clean = { ...env }; for (const name of SECRET_NAMES) delete clean[name]; return clean; }
function captured(command, args, options) { const result = spawnSync(command, args, { cwd: options.cwd, env: scrubEnvironment(options.env), input: options.input, encoding: 'utf8', stdio: 'pipe' }); return { code: result.status === 0 ? 0 : 1, stdout: result.stdout || '', stderr: result.stderr || '' }; }
function hash(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function remove(file) { fs.rmSync(file, { recursive: true, force: true }); }
function command(runCommand, commandName, args, options) { return Promise.resolve(runCommand(commandName, args, options)); }
function defaultToolchain(env) {
  const xcode = captured('/usr/bin/xcodebuild', ['-version'], { env }); const sdk = captured('/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-version'], { env }); const ld = captured('/usr/bin/xcrun', ['ld', '-v'], { env });
  if (xcode.code || sdk.code || ld.code || !/^Xcode 26\.6\nBuild version 17F113\n$/.test(xcode.stdout) || sdk.stdout.trim() !== '26.5' || !/PROJECT:ld-1267\b/.test(ld.stdout + ld.stderr)) reject('toolchain');
}
async function run({ inputs, env = process.env, root, runCommand = captured, toolchainCheck = defaultToolchain, hashFile = hash, emit = (line) => process.stdout.write(`${line}\n`) }) {
  let workspace; let stage; let privateEnv;
  try {
    const input = validateInputs(inputs);
    if (!env.CLAUDEX_PATCHER_DEPLOY_KEY || !env.CLAUDEX_PATCHER_REPOSITORY) reject('checkout');
    if (!sha(env.GITHUB_SHA, 40) || !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID || '') || !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT || '')) reject('proof');
    workspace = root || fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-patcher-'));
    const checkout = path.join(workspace, 'checkout'); const key = path.join(workspace, 'key'); const logs = path.join(workspace, 'logs'); const target = path.join(workspace, 'target');
    fs.mkdirSync(logs, { recursive: true, mode: 0o700 }); toolchainCheck({ ...env, DEVELOPER_DIR: '/Applications/Xcode_26.6.app/Contents/Developer' });
    fs.mkdirSync(path.join(workspace, 'ssh'), { recursive: true, mode: 0o700 }); fs.writeFileSync(key, env.CLAUDEX_PATCHER_DEPLOY_KEY, { mode: 0o600 });
    const gitEnv = { ...scrubEnvironment(env), GIT_SSH_COMMAND: `ssh -i ${key} -o IdentitiesOnly=yes -o LogLevel=ERROR -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${path.join(workspace, 'ssh', 'known_hosts')}` };
    const hostKey = await command(runCommand, 'ssh-keyscan', ['-H', '-t', 'ed25519', 'github.com'], { cwd: workspace, env: gitEnv });
    const fingerprint = await command(runCommand, 'ssh-keygen', ['-lf', '-'], { cwd: workspace, env: gitEnv, input: hostKey.stdout });
    if (hostKey.code || fingerprint.code || !/^256 SHA256:\+DiY3wvvV6TuJJhbpZisF\/zLDA0zPMSvHdkr4UvCOqU /.test(fingerprint.stdout)) reject('checkout');
    fs.writeFileSync(path.join(workspace, 'ssh', 'known_hosts'), hostKey.stdout, { mode: 0o600 });
    for (const args of [['init', '--quiet', checkout], ['-C', checkout, 'remote', 'add', 'origin', env.CLAUDEX_PATCHER_REPOSITORY], ['-C', checkout, 'fetch', '--quiet', '--depth=1', 'origin', input.subjectSha], ['-C', checkout, 'checkout', '--detach', '--quiet', 'FETCH_HEAD'], ['-C', checkout, 'rev-parse', 'HEAD']]) {
      const result = await command(runCommand, 'git', args, { cwd: workspace, env: gitEnv });
      if (result.code || (args.at(-1) === 'HEAD' && result.stdout.trim() !== input.subjectSha)) reject('checkout');
    }
    remove(key); delete env.CLAUDEX_PATCHER_DEPLOY_KEY; delete env.CLAUDEX_PATCHER_REPOSITORY;
    privateEnv = scrubEnvironment({ ...env, DEVELOPER_DIR: '/Applications/Xcode_26.6.app/Contents/Developer', HOME: path.join(workspace, 'home'), CARGO_HOME: path.join(workspace, 'cargo') });
    fs.mkdirSync(privateEnv.HOME, { recursive: true, mode: 0o700 }); fs.mkdirSync(privateEnv.CARGO_HOME, { recursive: true, mode: 0o700 });
    for (const [name, args] of [['mise', ['trust', '--yes', path.join(checkout, 'mise.toml')]], ['mise', ['install', '--locked']], ['mise', ['exec', '--', 'bun', 'install', '--frozen-lockfile']]]) { const result = await command(runCommand, name, args, { cwd: checkout, env: privateEnv }); if (result.code) reject('setup'); }
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    const targetEnv = { ...privateEnv };
    for (const [label, targetInfo] of [['QUALIFIED', input.profile === 'release' ? QUALIFIED : null], ['CURRENT', input.profile === 'ci' ? null : { sha256: input.currentSha256, version: input.currentVersion }]]) if (targetInfo) {
      const targetFile = path.join(target, `${label.toLowerCase()}.claude`); const downloaded = await command(runCommand, 'curl', ['--fail', '--silent', '--show-error', '--location', '--proto', '=https', '--proto-redir', '=https', '--max-redirs', '3', '--connect-timeout', '15', '--max-time', '120', '--max-filesize', '524288000', '--output', targetFile, officialUrl(targetInfo)], { cwd: checkout, env: privateEnv });
      if (downloaded.code || !fs.existsSync(targetFile) || hashFile(targetFile) !== targetInfo.sha256) reject('download'); fs.chmodSync(targetFile, 0o700); targetEnv[`CLAUDEX_PATCHER_${label}_TARGET_EXECUTABLE`] = targetFile; targetEnv[`CLAUDEX_PATCHER_${label}_TARGET_SHA256`] = targetInfo.sha256; targetEnv[`CLAUDEX_PATCHER_${label}_TARGET_VERSION`] = targetInfo.version;
    }
    const gates = []; let driftSummary = null;
    for (const gate of GATES[input.profile]) { const result = await command(runCommand, 'mise', gate.split(' ').slice(1), { cwd: checkout, env: targetEnv }); if (result.code) reject('gate'); gates.push({ name: gate, status: 'passed' }); if (gate === 'mise run verify:release' || gate === 'mise run drift:check') driftSummary = parseDriftSummary(result.stdout); }
    const tracked = path.join(checkout, 'prebuilds/darwin-arm64/claudex-patcher.node'); const rebuilt = path.join(target, 'rebuilt.node');
    if (!fs.existsSync(tracked)) reject('rebuild'); const rebuiltResult = await command(runCommand, 'mise', ['exec', '--', 'bun', 'scripts/build-native.ts', rebuilt], { cwd: checkout, env: targetEnv });
    if (rebuiltResult.code || !fs.existsSync(rebuilt) || hashFile(tracked) !== hashFile(rebuilt)) reject('rebuild');
    const proof = createProof({ ...input, builderCommitSha: env.GITHUB_SHA, trackedPrebuildSha256: hashFile(tracked), rebuiltPrebuildSha256: hashFile(rebuilt), gates, driftSummary, runId: Number(env.GITHUB_RUN_ID), runAttempt: Number(env.GITHUB_RUN_ATTEMPT) }); const proofJson = canonicalProof(proof);
    remove(checkout); remove(target); remove(logs); remove(key); remove(path.join(workspace, 'ssh')); remove(privateEnv.HOME); remove(privateEnv.CARGO_HOME);
    stage = path.join(env.RUNNER_TEMP || workspace, 'claudex-patcher-proof'); remove(stage); fs.mkdirSync(stage, { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(stage, 'proof.json'), proofJson, { mode: 0o600 }); return { ok: true, stage };
  } catch (error) {
    if (workspace) for (const item of ['checkout', 'target', 'logs', 'key', 'ssh', 'home', 'cargo']) remove(path.join(workspace, item)); if (stage) remove(stage); delete env.CLAUDEX_PATCHER_DEPLOY_KEY; delete env.CLAUDEX_PATCHER_REPOSITORY;
    const publicCode = error.code === 'input' ? 'PATCHER_INPUT_REJECTED' : error.code === 'toolchain' ? 'PATCHER_TOOLCHAIN_REJECTED' : error.code === 'checkout' ? 'PATCHER_CHECKOUT_REJECTED' : error.code === 'setup' ? 'PATCHER_SETUP_REJECTED' : error.code === 'download' ? 'PATCHER_DOWNLOAD_REJECTED' : error.code === 'gate' ? 'PATCHER_GATE_REJECTED' : error.code === 'drift' ? 'PATCHER_DRIFT_REJECTED' : error.code === 'rebuild' ? 'PATCHER_REBUILD_REJECTED' : error.code === 'proof' ? 'PATCHER_PROOF_REJECTED' : 'PATCHER_OPERATION_FAILED';
    emit(publicCode); return { ok: false, code: error.code };
  }
}
if (require.main === module) run({ inputs: { subjectSha: process.env.INPUT_SUBJECT_SHA || '', profile: process.env.INPUT_PROFILE || '', requestId: process.env.INPUT_REQUEST_ID || '', currentVersion: process.env.INPUT_CURRENT_VERSION || '', currentSha256: process.env.INPUT_CURRENT_SHA256 || '' } }).then((result) => { process.exitCode = result.ok ? 0 : 1; });
module.exports = { PROOF_KEYS, canonicalProof, createProof, officialTargets, officialUrl, parseDriftSummary, run, scrubEnvironment, validateInputs };
