# Ompex native builder

Build recipes for producing and validating Ompex native addon artifacts from an
exact private `ompex/engine` commit.

This repository intentionally contains no engine source. The workflow uses a
read-only deploy key, accepts only manual dispatches, checks out the requested
commit in an ephemeral runner, and does not upload source or build artifacts in
the initial proof.

The long-term contract is to compile and smoke-test native leaves on their
actual operating-system and CPU targets before the private engine publisher can
release a matching Bun package graph.
