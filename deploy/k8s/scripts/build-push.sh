#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
: "${REGISTRY:?Set REGISTRY to cr.us-north1.nebius.cloud/REGISTRY_ID_WITHOUT_registry_PREFIX}"
: "${IMAGE_TAG:?Set IMAGE_TAG to a unique release tag}"
for tool in docker nebius; do command -v "$tool" >/dev/null; done
# Uses the logged-in Nebius profile without putting a token on the command line.
nebius registry configure-helper
for entry in 'openharness:Dockerfile' 'mongodb-mcp:mongodb-mcp/Dockerfile' 'python-executor:python-executor/Dockerfile'; do
  image="${entry%%:*}"
  dockerfile="${entry#*:}"
  docker buildx build --platform "${PLATFORMS:-linux/amd64}" --push \
    -f "$dockerfile" -t "$REGISTRY/$image:$IMAGE_TAG" .
done
