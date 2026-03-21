#!/usr/bin/env bash
# =============================================================================
# scripts/build.sh — Build and push all Docker images to ECR
#
# Usage:
#   ./scripts/build.sh [git_sha]
#
# What it does:
#   1. Authenticates with ECR
#   2. Builds and pushes :sha-<git_sha> + :latest tags for all 5 images
#
# Called by:
#   - GitHub Actions "build" job (GIT_SHA set by the runner)
#   - Locally before deploy.sh for a manual full deploy
#
# Prerequisites:
#   - AWS CLI configured with ECR push permissions (or GitHub Actions OIDC role)
#   - Docker running
#   - chmod +x scripts/build.sh
# =============================================================================

set -euo pipefail

AWS_REGION="${AWS_REGION:-us-east-1}"
PROJECT_NAME="${PROJECT_NAME:-erp-pipeline}"
GIT_SHA="${1:-$(git rev-parse --short HEAD)}"
IMAGE_TAG="sha-${GIT_SHA}"

SERVICES=("productos" "ordenes" "stock" "nginx" "migrations")

declare -A BUILD_CONTEXTS=(
  [productos]="services/productos"
  [ordenes]="services/ordenes"
  [stock]="services/stock"
  [nginx]="nginx"
  [migrations]="migrations"
)

echo "=== Build: ${PROJECT_NAME} @ ${IMAGE_TAG} ==="
echo ""

AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR_BASE="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

echo "ECR: ${ECR_BASE}"
echo ""

# Step 1: Authenticate with ECR
echo "[1/2] Authenticating with ECR..."
aws ecr get-login-password --region "${AWS_REGION}" \
  | docker login --username AWS --password-stdin "${ECR_BASE}"

# Step 2: Build and push each image
echo ""
echo "[2/2] Building and pushing images..."

for service in "${SERVICES[@]}"; do
  context="${BUILD_CONTEXTS[$service]}"
  image_base="${ECR_BASE}/${PROJECT_NAME}-${service}"

  echo ""
  echo "  Building ${service} from ${context}/..."
  docker build \
    --tag "${image_base}:${IMAGE_TAG}" \
    --tag "${image_base}:latest" \
    --build-arg BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --build-arg GIT_SHA="${GIT_SHA}" \
    --file "${context}/Dockerfile" \
    "${context}"

  echo "  Pushing ${service}:${IMAGE_TAG}..."
  docker push "${image_base}:${IMAGE_TAG}"
  docker push "${image_base}:latest"
done

echo ""
echo "=== Build complete: ${IMAGE_TAG} ==="
echo ""
echo "Next: IMAGE_TAG=${IMAGE_TAG} bash scripts/deploy.sh"
