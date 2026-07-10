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
only as the encrypted `ENGINE_DEPLOY_KEY` Actions secret and is removed from the
ephemeral runner immediately after checkout.
