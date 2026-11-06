#!/usr/bin/env bash
# Build, check and roll out the app (and optionally the Python executor) on EKS.
#
#   scripts/deploy-eks.sh app            # the app image only
#   scripts/deploy-eks.sh app executor   # both
#
# The app runs one replica with a Recreate rollout, so a bad image means downtime. On 2026-11-06 a push left only
# a provenance attestation under the tag (no image layers): the new pod could not start and the old one was gone.
# So each image is pushed without provenance, its manifest must have real layers, and it must start in a throwaway
# pod before the deployment is touched. Then the overlay is pinned and applied, and the rollout is watched.
set -euo pipefail
cd "$(dirname "$0")/.."
REGISTRY=491085405405.dkr.ecr.us-east-1.amazonaws.com/openharness
NS=openharness
OVERLAY=deploy/k8s/overlays/aws/kustomization.yaml
SHA=$(git rev-parse --short=12 HEAD)
want_app=0 want_exec=0
for a in "$@"; do
  case "$a" in
    app) want_app=1 ;;
    executor) want_exec=1 ;;
    *) echo "usage: $0 app [executor]" >&2; exit 2 ;;
  esac
done
[ "$want_app$want_exec" = "00" ] && { echo "usage: $0 app [executor]" >&2; exit 2; }

aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin "${REGISTRY%%/*}" >/dev/null

build() { # name dockerfile
  local image="$REGISTRY/$1:$SHA"
  echo "== build $image"
  docker buildx build --platform linux/amd64 --provenance=false --push -f "$2" -t "$image" . >/dev/null
  # The tag must be an image with filesystem layers, not an attestation.
  docker buildx imagetools inspect --raw "$image" | python3 -c '
import json, sys
m = json.load(sys.stdin)
layers = [l["mediaType"] for l in m.get("layers", [])]
if not layers or any("in-toto" in l for l in layers):
    sys.exit(f"bad manifest: {m.get(\"mediaType\")} with layers {layers}")
print(f"   manifest ok: {len(layers)} layers")'
}
precheck() { # name command...
  local image="$REGISTRY/$1:$SHA" pod="precheck-$1-$RANDOM"
  shift
  echo "== start $image in a throwaway pod"
  kubectl -n "$NS" run "$pod" --image="$image" --restart=Never --command -- "$@" >/dev/null
  local phase=""
  for _ in $(seq 1 60); do
    phase=$(kubectl -n "$NS" get pod "$pod" -o jsonpath='{.status.phase}' 2>/dev/null || true)
    [ "$phase" = Succeeded ] || [ "$phase" = Failed ] && break
    sleep 3
  done
  kubectl -n "$NS" logs "$pod" 2>/dev/null | tail -1 || true
  kubectl -n "$NS" delete pod "$pod" --wait=false >/dev/null
  [ "$phase" = Succeeded ] || { echo "precheck failed: $phase" >&2; exit 1; }
}

if [ "$want_app" = 1 ]; then
  build app Dockerfile
  precheck app node -e "console.log('app image ok', process.version)"
  sed -i '' "14s/newTag: .*/newTag: $SHA/" "$OVERLAY"
fi
if [ "$want_exec" = 1 ]; then
  build python-executor python-executor/Dockerfile
  precheck python-executor python -c "import pipeline.strategy.engine; print('executor image ok')"
  sed -i '' "23s/newTag: .*/newTag: $SHA/" "$OVERLAY"
fi

# Nothing in flight that a restart would interrupt (transform runs, harness runs, evaluations, simulations).
POD=$(kubectl -n "$NS" get pods -o name | grep '^pod/app-' | head -1 | cut -d/ -f2)
kubectl -n "$NS" exec "$POD" -c api -- node -e "
const { connectDatabase, collection, mongo } = await import('/app/dist/packages/core/src/db.js');
await connectDatabase();
const busy = {};
for (const c of ['transform_runs', 'runs', 'evaluations', 'simulations']) busy[c] = await collection(c).countDocuments({ status: { \$in: ['queued', 'running'] } });
await mongo.close();
console.log('in flight', JSON.stringify(busy));
if (Object.values(busy).some(Boolean) && !process.env.FORCE) process.exit(3);
" --input-type=module || { echo "work is in flight; wait, or set FORCE=1" >&2; exit 3; }

kubectl apply -k deploy/k8s/overlays/aws | grep -E 'deployment.apps/app' || true
kubectl -n "$NS" rollout status deploy/app --timeout=400s
echo "== live: $(kubectl -n "$NS" get deploy app -o jsonpath='{.spec.template.spec.containers[0].image}')"
echo "Pinned $SHA in $OVERLAY: commit it on a chore/deploy-$SHA branch and open the deploy PR."
