---
name: aws-eks-deployment
description: How OpenHarness is deployed on the deepfinery-training-eks cluster behind the shared ALB
metadata:
  type: project
---

OpenHarness runs on EKS cluster `deepfinery-training-eks` (us-east-1, account 491085405405),
namespace `openharness`, reachable at https://openharness.faberiq.ai.

- Overlay `deploy/k8s/overlays/aws` (kustomization + storageclass.yaml + proxy-http.yaml) is the
  AWS deployment. It excludes the Caddy TLS proxy, NeMo guardrails, and Garak; builds 4 ECR images
  (`491085405405.dkr.ecr.us-east-1.amazonaws.com/openharness/{app,gateway,mongodb-mcp,python-executor}`).
- Ingress is NOT via an in-cluster controller. A Terraform-managed ALB `deepfinery-training-eks-alb`
  forwards host `openharness.faberiq.ai` (HTTPS:443 listener; port 80 redirects to 443) to instance
  target group `openharness` on **NodePort 32020**. The contract: expose a `NodePort` Service with
  `nodePort: 32020`, `port: 80 → targetPort`. Here `openharness-alb` fronts an HTTP Caddy router
  (oh-proxy) that routes /connect + /mcp/* → gateway:8090, everything else → api:8088. TLS lives at
  the ALB, so the app's PUBLIC_URL is https and Caddy pins X-Forwarded-Proto: https.
- Storage: StorageClass `openharness-gp3` (ebs.csi.aws.com, gp3, encrypted, **reclaimPolicy: Retain**,
  volume expansion). mongo/rabbitmq/weaviate/files PVCs use it so data persists.
- Manual infra step (codify in Terraform to avoid drift): node SG `sg-0c0ca475927ea2e14` needed an
  inbound rule for tcp/32020 from ALB SG `sg-0221b16aacf917c51` (rule sgr-0dcc430800a7f1209). Without
  it the target group health-checks time out. Terraform created the TG but not this SG rule.
- Secrets live in gitignored `deploy/k8s/.local/secrets.json` and k8s secret `openharness-secrets`.
