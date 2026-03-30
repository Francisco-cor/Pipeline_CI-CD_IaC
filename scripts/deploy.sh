#!/usr/bin/env bash
# =============================================================================
# scripts/deploy.sh — Register new ECS task definition and update the service
#
# Usage:
#   IMAGE_TAG=sha-abc1234 ./scripts/deploy.sh
#   ./scripts/deploy.sh           # derives tag from current HEAD
#
# What it does:
#   1. Fetches the current ECS task definition
#   2. Replaces image tags in each container definition with IMAGE_TAG
#   3. Registers the new task definition revision
#   4. Updates the ECS service to use the new revision
#   5. Waits for the deployment to stabilize (or times out after 10 min)
#
# Rollback mechanism:
#   If the new task fails health checks, ECS automatically rolls back to the
#   previous revision (deployment_circuit_breaker with rollback=true in Terraform).
#   Watch the ECS console Events tab during deploys.
#
# Called by:
#   - GitHub Actions "deploy" job (IMAGE_TAG passed from the build job output)
#   - Locally after build.sh for a manual full deploy
#
# Full manual deploy:
#   bash scripts/build.sh && IMAGE_TAG=sha-$(git rev-parse --short HEAD) bash scripts/deploy.sh
#
# Prerequisites:
#   - AWS CLI configured with ECS deployment permissions
#   - Images already pushed to ECR (run build.sh first)
#   - chmod +x scripts/deploy.sh
# =============================================================================

set -euo pipefail

# --- Configuration ---
AWS_REGION="${AWS_REGION:-us-east-2}"
PROJECT_NAME="${PROJECT_NAME:-erp-pipeline}"
ENVIRONMENT="${ENVIRONMENT:-dev}"
GIT_SHA="${1:-$(git rev-parse --short HEAD)}"
IMAGE_TAG="${IMAGE_TAG:-sha-${GIT_SHA}}"

CLUSTER_NAME="${PROJECT_NAME}-${ENVIRONMENT}-cluster"
SERVICE_NAME="${PROJECT_NAME}-${ENVIRONMENT}-service"
TASK_FAMILY="${PROJECT_NAME}-${ENVIRONMENT}-app"

echo "=== Deploy: ${PROJECT_NAME}-${ENVIRONMENT} @ ${IMAGE_TAG} ==="
echo ""

AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR_BASE="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

echo "Account:  ${AWS_ACCOUNT_ID}"
echo "Cluster:  ${CLUSTER_NAME}"
echo "Service:  ${SERVICE_NAME}"
echo ""

# --- Step 1: Register new task definition revision with updated image tags ---
echo "[1/2] Registering new task definition revision..."

CURRENT_TASK_DEF=$(aws ecs describe-task-definition \
  --task-definition "${TASK_FAMILY}" \
  --query 'taskDefinition' \
  --output json \
  --region "${AWS_REGION}")

# Swap image tags using Python3 — reliable JSON handling without jq quoting issues
NEW_TASK_DEF=$(echo "${CURRENT_TASK_DEF}" | python3 -c "
import sys, json

data = json.load(sys.stdin)
ecr_base = '${ECR_BASE}'
project = '${PROJECT_NAME}'
tag = '${IMAGE_TAG}'

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

# Remove read-only fields that cannot be passed to register-task-definition
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

# --- Step 2: Update service and wait for stable deployment ---
echo ""
echo "[2/2] Updating ECS service..."

aws ecs update-service \
  --cluster "${CLUSTER_NAME}" \
  --service "${SERVICE_NAME}" \
  --task-definition "${NEW_REVISION}" \
  --region "${AWS_REGION}" \
  --output text \
  --query 'service.serviceName' > /dev/null

echo "  Service updated. Waiting for deployment to stabilize..."
echo "  (If health checks fail, ECS will auto-rollback — watch ECS console Events tab)"
echo ""

# Wait up to 10 minutes for runningCount == desiredCount with no in-progress deployments
aws ecs wait services-stable \
  --cluster "${CLUSTER_NAME}" \
  --services "${SERVICE_NAME}" \
  --region "${AWS_REGION}"

echo ""
echo "=== Deploy complete ==="
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
