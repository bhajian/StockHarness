#!/bin/sh
# Runs the oh SDK tests inside the real executor image against a throwaway MongoDB in an isolated test project.
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
PROJECT="openharness-test-ohsdk-$$"
docker build -q -f python-executor/Dockerfile -t openharness-python-executor:sdk-test . >/dev/null
docker network create "$PROJECT" >/dev/null
cleanup() { docker rm -f "$PROJECT-mongo" >/dev/null 2>&1 || true; docker network rm "$PROJECT" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker run -d --name "$PROJECT-mongo" --network "$PROJECT" --label "com.docker.compose.project=$PROJECT" mongo:7.0 >/dev/null
docker run --rm --network "$PROJECT" -e MONGODB_URI="mongodb://$PROJECT-mongo:27017/ohsdk_test" \
  -v "$PWD/python-executor:/sdk:ro" -w /sdk -e PYTHONPATH=/sdk --entrypoint python \
  openharness-python-executor:sdk-test -m unittest discover -s tests -v
