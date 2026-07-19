# Ompex native builder

Target-native build recipes for an exact private `ompex/engine` commit.

This repository intentionally contains no engine source. A build
(`build.yml`, via manual `workflow_dispatch` or a `workflow_call` from the
poll below):

1. validates an exact 40-character engine commit SHA;
2. checks it out through a read-only deploy key (host keys pinned over
   authenticated HTTPS, never TOFU `ssh-keyscan`);
3. computes the canonical native source hash with the engine's own
   `scripts/ci/native-source-hash.sh` (single shared implementation);
4. executes that commit's own `.github/actions/build-native` action, which
   builds the addon and writes a provenance manifest (engine SHA, source
   hash, target, toolchain, per-file SHA-256 checksums); and
5. uploads two artifacts per target: the addon
   (`pi-natives-<target>-h<hash>`) and its manifest
   (`pi-natives-manifest-<target>-h<hash>-s<engineSha>`).

The matrix runs on the actual supported operating-system and CPU targets:

- Linux x64, baseline and modern ISA variants;
- Linux ARM64;
- macOS Intel x64; and
- macOS Apple Silicon ARM64.

## Automatic release builds

`poll-engine.yml` closes the release loop without any cross-repo write
credential: on a 10-minute schedule (or manual dispatch) it lists engine
release tags through the read-only deploy key, and when the newest tag has
no complete attested artifact set in this repository it calls `build.yml`
for that commit. Engine release CI waits for the attested set and verifies
every manifest against the release commit before publishing.

Because `build.yml` runs via `workflow_call` here, its artifacts belong to
the poll run - consumers must locate artifacts by name (the engine's
`scripts/ci/native-find.sh` does), never by `build.yml` run listing.

If the engine is given a `NATIVE_BUILDER_TOKEN` able to dispatch this
repository (fine-grained PAT or GitHub App installation token with
`actions: write`), its release CI dispatches `build.yml` directly and the
poll becomes a backup path.

## Privacy boundary

No pull-request or push event can access the deploy key. The private key
exists only as the encrypted `ENGINE_DEPLOY_KEY` Actions secret and is
removed from the ephemeral runner immediately after checkout. Only compiled
addons and provenance manifests are uploaded; build, clippy, and test
output is withheld from the public logs entirely (success and failure), so
private source never reaches them.
