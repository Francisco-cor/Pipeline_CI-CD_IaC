#!/usr/bin/env bash
# =============================================================================
# scripts/deploy.sh — Manual deploy script
#
# Usage:
#   ./scripts/deploy.sh [git_sha]
#
# What it does:
#   1. Authenticates with ECR
#   2. Builds each service image (productos, ordenes, stock, nginx, migrations)
#   3. Pushes with :sha-<git_sha> and :latest tags
#   4. Registers a new ECS task definition revision with the pushed image URIs
#   5. Updates the ECS service to use the new revision
#   6. Waits for the deployment to stabilize
#
# Rollback mechanism:
#   If the new task fails health checks, ECS automatically rolls back to the
#   previous revision (deployment_circuit_breaker with rollback = true in Terraform).
#   You'll see the rollback in the ECS console under the service Events tab.
#   This is NOT a script-driven rollback — ECS handles it natively.
#
# Week 3: GitHub Actions calls this script. Same script, automated trigger.
# Having the script separate from CI lets you test deploys without a pipeline.
#
# Prerequisites:
#   - AWS CLI configured with appropriate permissions
#   - Docker running
#   - Terraform outputs available (run `terraform output -json` in terraform/)
#   - chmod +x scripts/deploy.sh
# =============================================================================

set -euo pipefail

# --- Configuration ---
AWS_REGION="${AWS_REGION:-us-east-1}"
PROJECT_NAME="${PROJECT_NAME:-erp-pipeline}"
ENVIRONMENT="${ENVIRONMENT:-dev}"
GIT_SHA="${1:-$(git rev-parse --short HEAD)}"
IMAGE_TAG="sha-${GIT_SHA}"

SERVICES=("productos" "ordenes" "stock" "nginx" "migrations")

echo "=== Deploy: ${PROJECT_NAME}-${ENVIRONMENT} @ ${IMAGE_TAG} ==="
echo ""

# --- Resolve AWS account and ECR base URL ---
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR_BASE="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
CLUSTER_NAME="${PROJECT_NAME}-${ENVIRONMENT}-cluster"
SERVICE_NAME="${PROJECT_NAME}-${ENVIRONMENT}-service"
TASK_FAMILY="${PROJECT_NAME}-${ENVIRONMENT}-app"

echo "Account:  ${AWS_ACCOUNT_ID}"
echo "ECR base: ${ECR_BASE}"
echo "Cluster:  ${CLUSTER_NAME}"
echo "Service:  ${SERVICE_NAME}"
echo ""

# --- Step 1: Authenticate with ECR ---
echo "[1/4] Authenticating with ECR..."
aws ecr get-login-password --region "${AWS_REGION}" \
  | docker login --username AWS --password-stdin "${ECR_BASE}"

# --- Step 2: Build and push each service image ---
echo ""
echo "[2/4] Building and pushing images..."

# Map service name → build context directory (relative to repo root)
declare -A BUILD_CONTEXTS=(
  [productos]="services/productos"
  [ordenes]="services/ordenes"
  [stock]="services/stock"
  [nginx]="nginx"
  [migrations]="migrations"
)

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

# --- Step 3: Register new task definition revision with pushed image URIs ---
echo ""
echo "[3/4] Registering new task definition revision..."

# Fetch the current task definition as JSON, swap image tags, register new revision.
# This approach (fetch → modify → register) avoids maintaining a separate JSON file
# and ensures all other task definition settings (IAM roles, resource limits, etc.)
# are preserved exactly as Terraform left them.
CURRENT_TASK_DEF=$(aws ecs describe-task-definition \
  --task-definition "${TASK_FAMILY}" \
  --query 'taskDefinition' \
  --output json \
  --region "${AWS_REGION}")

# Build the new task definition JSON with updated image tags for each container.
# python3 is used here because it's available on all CI runners and handles JSON
# reliably without the quoting issues that come with jq in shell scripts.
NEW_TASK_DEF=$(echo "${CURRENT_TASK_DEF}" | python3 -c "
import sys, json

data = json.load(sys.stdin)
ecr_base = '${ECR_BASE}'
project = '${PROJECT_NAME}'
tag = '${IMAGE_TAG}'

# Map container name → ECR service name
container_to_service = {
  'svc-productos': 'productos',
  'svc-ordenes':   'ordenes',
  'svc-stock':     'stock',
  'nginx':         'nginx',
  'migrations':    'migrations',
}

for container in data['containerDefinitions']:
  name = container['name']
  if name in container_to_service:
    service = container_to_service[name]
    container['image'] = f'{ecr_base}/{project}-{service}:{tag}'

# Remove fields that can't be included in register-task-definition
for field in ['taskDefinitionArn', 'revision', 'status', 'requiresAttributes',
              'compatibilities', 'registeredAt', 'registeredBy']:
  data.pop(field, None)

print(json.dumps(data))
")

NEW_REVISION=$(aws ecs register-task-definition \
  --cli-input-json "${NEW_TASK_DEF}" \
  --region "${AWS_REGION}" \
  --query 'taskDefinition.taskDefinitionArn' \
  --output text)

echo "  Registered: ${NEW_REVISION}"

# --- Step 4: Update service and wait for stable deployment ---
echo ""
echo "[4/4] Updating ECS service..."

aws ecs update-service \
  --cluster "${CLUSTER_NAME}" \
  --service "${SERVICE_NAME}" \
  --task-definition "${NEW_REVISION}" \
  --region "${AWS_REGION}" \
  --output text \
  --query 'service.serviceName' > /dev/null

echo "  Service updated. Waiting for deployment to stabilize..."
echo "  (If health checks fail, ECS will auto-rollback — watch the ECS console Events tab)"
echo ""

# Wait up to 10 minutes for the service to stabilize.
# 'services-stable' resolves when runningCount == desiredCount and no deployments
# are in progress. If ECS rolls back, this will timeout — check the Events tab.
aws ecs wait services-stable \
  --cluster "${CLUSTER_NAME}" \
  --services "${SERVICE_NAME}" \
  --region "${AWS_REGION}"

echo ""
echo "=== Deploy complete! ==="
echo ""
echo "Task definition: ${NEW_REVISION}"
echo ""
echo "Get the task public IP:"
echo "  TASK_ARN=\$(aws ecs list-tasks --cluster ${CLUSTER_NAME} --query 'taskArns[0]' --output text)"
echo "  ENI_ID=\$(aws ecs describe-tasks --cluster ${CLUSTER_NAME} --tasks \$TASK_ARN --query 'tasks[0].attachments[0].details[?name==\`networkInterfaceId\`].value' --output text)"
echo "  aws ec2 describe-network-interfaces --network-interface-ids \$ENI_ID --query 'NetworkInterfaces[0].Association.PublicIp' --output text"
echo ""
echo "Test endpoints:"
echo "  curl http://<PUBLIC_IP>/health"
echo "  curl http://<PUBLIC_IP>/api/productos/health"
echo "  curl http://<PUBLIC_IP>/api/ordenes/health"
echo "  curl http://<PUBLIC_IP>/api/stock/health"
