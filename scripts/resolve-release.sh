#!/usr/bin/env bash
# Find the newest ompex/engine release tag and decide whether its attested
# native artifact set still needs building. Emits GITHUB_OUTPUT lines
# (engine_ref=, needed=) on stdout; progress on stderr.
#
# env:
#   ENGINE_DEPLOY_KEY  (required) read-only deploy key for ompex/engine
#   GH_TOKEN           (required) token for gh api (github.token suffices)
#   BUILDER_REPO       default ompex/native-builder
set -euo pipefail
BUILDER_REPO="${BUILDER_REPO:-ompex/native-builder}"
ENGINE_GIT="git@github.com:ompex/engine.git"

install -d -m 0700 ~/.ssh
install -m 0600 /dev/null ~/.ssh/engine_deploy_key
printf '%s\n' "$ENGINE_DEPLOY_KEY" >~/.ssh/engine_deploy_key
trap 'rm -f ~/.ssh/engine_deploy_key' EXIT
# Host keys over authenticated HTTPS (TLS PKI), not TOFU ssh-keyscan.
gh api meta --jq '.ssh_keys[] | "github.com \(.)"' >~/.ssh/known_hosts
export GIT_SSH_COMMAND="ssh -i $HOME/.ssh/engine_deploy_key -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$HOME/.ssh/known_hosts"

# Newest ompex-v* release tags by version order (newest first, up to 3):
# one unbuilt tag is built per poll cycle, so a burst of releases drains
# across successive cycles within the engine's release wait window.
tag_refs=$(git ls-remote --tags "$ENGINE_GIT" 'refs/tags/ompex-v*' |
	grep -v '\^{}' | awk '{print $2}' | sort -V | tail -n 3 | tac)
if [ -z "$tag_refs" ]; then
	echo "no release tags yet" >&2
	echo "engine_ref="
	echo "needed=false"
	exit 0
fi

workdir=$(mktemp -d)
for tag_ref in $tag_refs; do
	ref=$(git ls-remote "$ENGINE_GIT" "$tag_ref" | awk '{print $1}')
	echo "checking ${tag_ref} -> ${ref}" >&2
	rm -rf "$workdir/engine"
	git init -q "$workdir/engine"
	(
		cd "$workdir/engine"
		git remote add origin "$ENGINE_GIT"
		git fetch -q --depth=1 origin "$ref"
		git checkout -q --detach FETCH_HEAD
	)
	hash=$(cd "$workdir/engine" && bash scripts/ci/native-source-hash.sh)
	echo "native source hash: ${hash}" >&2
	# Attested set already present in some run of the builder repo?
	HASH="$hash" ENGINE_SHA="$ref" IS_RELEASE=true WAIT_MINUTES=0 \
		BUILDER_REPO="$BUILDER_REPO" \
		bash "$workdir/engine/scripts/ci/native-find.sh" >"$workdir/find.out"
	cross=$(grep '^cross-platform-run-id=' "$workdir/find.out" | cut -d= -f2)
	if [ -z "$cross" ]; then
		echo "unbuilt release tag: ${tag_ref}" >&2
		echo "engine_ref=${ref}"
		echo "needed=true"
		exit 0
	fi
	echo "attested set already present for ${tag_ref} (run ${cross})" >&2
done
echo "engine_ref="
echo "needed=false"
