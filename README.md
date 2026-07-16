# Ompex native builder

Target-native build recipes for an exact private `ompex/engine` commit.

This repository intentionally contains no engine source. A manual dispatch:

1. validates an exact 40-character engine commit SHA;
2. checks it out through a read-only deploy key;
3. executes that commit's own `.github/actions/build-native` action; and
4. uploads the resulting native addon artifact.

The matrix runs on the actual supported operating-system and CPU targets:

- Linux x64, baseline and modern ISA variants;
- Linux ARM64;
- macOS Intel x64; and
- macOS Apple Silicon ARM64.

No pull-request or push event can access the deploy key. The private key exists
only as an encrypted Actions secret and is removed from the ephemeral runner
immediately after checkout.

## Claudex patcher

`Claudex patcher` is a separate manual-only workflow for one Apple Silicon
patcher target. It accepts only an exact source SHA, a fixed verification
profile, and a request UUID. The workflow validates those inputs before using
its dedicated checkout key, runs the private verification with captured output,
and deletes private checkout, credential, logs, target files, and temporary
homes before artifact upload.

Its only artifact is a public-owned, canonical `proof.json`. The proof records
approved hashes, fixed toolchain facts, profile gates, and public target facts;
it never contains private source, paths, diagnostics, executable bytes, URLs,
or credentials. The engine build workflow remains separate and unchanged.
