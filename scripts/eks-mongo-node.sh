#!/usr/bin/env bash
# A dedicated, memory-optimized EKS node for MongoDB (#415), and a faster gp3 volume. Idempotent: re-running it
# changes nothing that is already in place.
#
#   scripts/eks-mongo-node.sh            # create / check
#   DRY_RUN=1 scripts/eks-mongo-node.sh  # print what would change
#
# The cluster's own node group (deepfinery-training-eks-ng, shared with another project) is managed by that
# project's Terraform; this script adds a separate node group tagged Project=stockharness and never touches it.
# The node must sit in the availability zone of the Mongo volume (EBS volumes are zonal).
set -euo pipefail
REGION=${REGION:-us-east-1}
CLUSTER=${CLUSTER:-deepfinery-training-eks}
NODEGROUP=${NODEGROUP:-openharness-mongo}
INSTANCE=${INSTANCE:-r7i.xlarge} # 4 vCPU, 32 GiB
NS=openharness
IOPS=${IOPS:-6000}
THROUGHPUT=${THROUGHPUT:-250} # MB/s
run() { if [ -n "${DRY_RUN:-}" ]; then echo "DRY_RUN: $*"; else "$@"; fi; }

pv=$(kubectl -n "$NS" get pvc data-mongo-0 -o jsonpath='{.spec.volumeName}')
vol=$(kubectl get pv "$pv" -o jsonpath='{.spec.csi.volumeHandle}')
az=$(aws ec2 describe-volumes --region "$REGION" --volume-ids "$vol" --query 'Volumes[0].AvailabilityZone' --output text)
echo "Mongo volume $vol in $az"

# The cluster node group's role and the subnet in the volume's zone.
base=$(aws eks list-nodegroups --region "$REGION" --cluster-name "$CLUSTER" --query 'nodegroups' --output text | tr '\t' '\n' | grep -v "^$NODEGROUP$" | head -1)
role=$(aws eks describe-nodegroup --region "$REGION" --cluster-name "$CLUSTER" --nodegroup-name "$base" --query 'nodegroup.nodeRole' --output text)
subnets=$(aws eks describe-nodegroup --region "$REGION" --cluster-name "$CLUSTER" --nodegroup-name "$base" --query 'nodegroup.subnets' --output text)
subnet=$(aws ec2 describe-subnets --region "$REGION" --subnet-ids $subnets --filters "Name=availability-zone,Values=$az" --query 'Subnets[0].SubnetId' --output text)
[ "$subnet" != "None" ] || { echo "no node subnet in $az" >&2; exit 1; }

if aws eks describe-nodegroup --region "$REGION" --cluster-name "$CLUSTER" --nodegroup-name "$NODEGROUP" >/dev/null 2>&1; then
  echo "Node group $NODEGROUP exists: $(aws eks describe-nodegroup --region "$REGION" --cluster-name "$CLUSTER" --nodegroup-name "$NODEGROUP" --query 'nodegroup.[status,instanceTypes[0]]' --output text)"
else
  echo "Creating node group $NODEGROUP ($INSTANCE in $az, subnet $subnet)"
  run aws eks create-nodegroup --region "$REGION" --cluster-name "$CLUSTER" --nodegroup-name "$NODEGROUP" \
    --node-role "$role" --subnets "$subnet" --instance-types "$INSTANCE" --capacity-type ON_DEMAND \
    --ami-type AL2023_x86_64_STANDARD --disk-size 50 \
    --scaling-config minSize=1,maxSize=1,desiredSize=1 \
    --labels openharness.io/role=mongo \
    --taints key=openharness.io/dedicated,value=mongo,effect=NO_SCHEDULE \
    --tags Project=stockharness,Managed=stockharness-repo,Purpose=mongodb >/dev/null
  [ -n "${DRY_RUN:-}" ] || aws eks wait nodegroup-active --region "$REGION" --cluster-name "$CLUSTER" --nodegroup-name "$NODEGROUP"
  echo "Node group $NODEGROUP active"
fi

# gp3 performance: raised online, no detach (one change per volume every 6 hours).
read -r cur_iops cur_tp < <(aws ec2 describe-volumes --region "$REGION" --volume-ids "$vol" --query 'Volumes[0].[Iops,Throughput]' --output text)
if [ "$cur_iops" -lt "$IOPS" ] || [ "$cur_tp" -lt "$THROUGHPUT" ]; then
  echo "Raising $vol from $cur_iops IOPS / $cur_tp MB/s to $IOPS / $THROUGHPUT"
  run aws ec2 modify-volume --region "$REGION" --volume-id "$vol" --iops "$IOPS" --throughput "$THROUGHPUT" >/dev/null
else
  echo "Volume $vol already at $cur_iops IOPS / $cur_tp MB/s"
fi
echo "Next: kubectl apply -k deploy/k8s/overlays/aws (Mongo moves to the node; a few minutes of downtime)."
