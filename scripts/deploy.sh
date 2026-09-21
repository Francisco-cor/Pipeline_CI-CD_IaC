#!/usr/bin/env bash
# =============================================================================
# scripts/deploy.sh — Register new ECS task definition and update the service
# Fase 7.7: hardened — lock, image verify, digest check, wait + rollback detect
#
# Usage:
#   IMAGE_TAG=sha-abc1234 ./scripts/deploy.sh
#   DEPLOY_SERVICES=productos,nginx IMAGE_TAG=sha-abc1234 ./scripts/deploy.sh
#   ./scripts/deploy.sh           # derives tag from current HEAD
#
# What it does:
#   1. Acquires deploy lock (flock) to prevent concurrent deploys
#   2. Verifies selected IMAGE_TAG images exist in ECR and records digests
#   3. Fetches current task definition
#   4. Replaces only selected services with immutable image digests
#   5. Registers new task definition revision and verifies digest
#   6. Updates ECS service and waits for services-stable (10m)
#   7. Detects circuit-breaker rollback via service events
#
# Rollback mechanism:
#   ECS deployment_circuit_breaker { rollback=true } in
#   terraform/modules/compute/main.tf:375. If health checks fail,
#   ECS reverts to previous revision automatically.
#
# Called by:
#   - GitHub Actions "deploy" job (IMAGE_TAG from build output)
#   - Locally: bash scripts/build.sh && IMAGE_TAG=sha-... bash scripts/deploy.sh
#
# Prerequisites:
#   - AWS CLI + IAM ecs:DescribeTaskDefinition/Register/UpdateService/ListTasks/DescribeServices
#   - ECR images already pushed (build.sh)
#   - python3 + flock (util-linux) — fallback to mkdir lock if missing
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

SERVICES=("productos" "ordenes" "stock" "nginx" "migrations" "gateway")
DEPLOY_SERVICES="${DEPLOY_SERVICES:-productos,ordenes,stock,nginx,migrations,gateway}"

LOCK_FILE="/tmp/erp-deploy-${ENVIRONMENT}.lock"
LOCK_FD=200

# --- Lock (Fase 7.7) ---
acquire_lock() {
  # Try flock if available, else mkdir lock
  if command -v flock >/dev/null 2>&1; then
    eval "exec ${LOCK_FD}>${LOCK_FILE}"
    if ! flock -n "${LOCK_FD}"; then
      echo "ERROR: another deploy holds lock ${LOCK_FILE} — concurrent deploys blocked." >&2
      echo "Wait for the other deploy to finish or remove stale lock: rm ${LOCK_FILE}" >&2
      exit 1
    fi
    echo "Lock acquired: ${LOCK_FILE} (flock)"
  else
    if ! mkdir "${LOCK_FILE}.dir" 2>/dev/null; then
      echo "ERROR: another deploy holds lock ${LOCK_FILE}.dir" >&2
      exit 1
    fi
    echo "Lock acquired: ${LOCK_FILE}.dir (mkdir)"
  fi
}

release_lock() {
  if command -v flock >/dev/null 2>&1; then
    flock -u "${LOCK_FD}" 2>/dev/null || true
    rm -f "${LOCK_FILE}"
  else
    rmdir "${LOCK_FILE}.dir" 2>/dev/null || true
  fi
  echo "Lock released."
}
trap release_lock EXIT
acquire_lock

echo "=== Deploy: ${PROJECT_NAME}-${ENVIRONMENT} @ ${IMAGE_TAG} ==="
echo "Services: ${DEPLOY_SERVICES}"
echo ""

# Validate the comma-separated service selection before it reaches Python/AWS.
IFS=',' read -r -a DEPLOY_SERVICE_LIST <<< "${DEPLOY_SERVICES}"
if [ "${#DEPLOY_SERVICE_LIST[@]}" -eq 0 ]; then
  echo "ERROR: DEPLOY_SERVICES must contain at least one service." >&2
  exit 1
fi
for svc in "${DEPLOY_SERVICE_LIST[@]}"; do
  case " ${SERVICES[*]} " in
    *" ${svc} "*) ;;
    *) echo "ERROR: unknown service in DEPLOY_SERVICES: ${svc}" >&2; exit 1 ;;
  esac
done

# Validate tag format
if [[ ! "${IMAGE_TAG}" =~ ^sha-[0-9a-f]{4,40}$ ]] && [[ ! "${IMAGE_TAG}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] && [[ "${IMAGE_TAG}" != "latest" ]]; then
  echo "WARN: IMAGE_TAG '${IMAGE_TAG}' does not match sha-<sha>/vX.Y.Z/latest — proceeding but verify intent." >&2
fi

AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR_BASE="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

echo "Account:  ${AWS_ACCOUNT_ID}"
echo "Cluster:  ${CLUSTER_NAME}"
echo "Service:  ${SERVICE_NAME}"
echo "Lock:     ${LOCK_FILE}"
echo ""

# --- Verify selected images exist in ECR (Fase 7.7) ---
echo "[0/3] Verifying selected images exist in ECR @ ${IMAGE_TAG}..."
MISSING=0
IMAGE_DIGESTS_LINES=""
for svc in "${DEPLOY_SERVICE_LIST[@]}"; do
  repo="${PROJECT_NAME}-${svc}"
  echo "  Checking ${repo}:${IMAGE_TAG}..."
  if ! aws ecr describe-images --repository-name "${repo}" --image-ids imageTag="${IMAGE_TAG}" --region "${AWS_REGION}" >/dev/null 2>&1; then
    echo "    MISSING: ${repo}:${IMAGE_TAG} not found in ECR — did build.sh push?" >&2
    MISSING=$((MISSING+1))
  else
    # Fetch the immutable digest used in the new task definition.
    DIGEST=$(aws ecr describe-images --repository-name "${repo}" --image-ids imageTag="${IMAGE_TAG}" --region "${AWS_REGION}" --query 'imageDetails[0].imageDigest' --output text 2>/dev/null || echo "unknown")
    if [[ ! "${DIGEST}" =~ ^sha256:[0-9a-f]{64}$ ]]; then
      echo "    MISSING: ${repo}:${IMAGE_TAG} returned an invalid digest (${DIGEST})." >&2
      MISSING=$((MISSING+1))
    else
      IMAGE_DIGESTS_LINES+="${svc}=${DIGEST}"$'\n'
      echo "    OK: ${repo}:${IMAGE_TAG} digest ${DIGEST}"
    fi
  fi
done
if [ "${MISSING}" -gt 0 ]; then
  echo "ERROR: ${MISSING} selected image(s) missing — aborting deploy. Build first: bash scripts/build.sh" >&2
  exit 1
fi
echo "  All ${#DEPLOY_SERVICE_LIST[@]} selected images verified."
echo ""

# --- Step 1: Register new task definition revision ---
echo "[1/3] Registering new task definition revision..."

CURRENT_TASK_DEF=$(aws ecs describe-task-definition \
  --task-definition "${TASK_FAMILY}" \
  --query 'taskDefinition' \
  --output json \
  --region "${AWS_REGION}")

# Swap only selected services to immutable digests using Python's JSON parser.
# Unchanged services keep the image reference from the current task, making
# paths-filter builds safe while preserving rollback semantics.
NEW_TASK_DEF=$(CURRENT_TASK_DEF="${CURRENT_TASK_DEF}" \
  ECR_BASE="${ECR_BASE}" PROJECT_NAME="${PROJECT_NAME}" \
  DEPLOY_SERVICES="${DEPLOY_SERVICES}" IMAGE_DIGESTS_LINES="${IMAGE_DIGESTS_LINES}" \
  python3 -c "
import json
import os

data = json.loads(os.environ['CURRENT_TASK_DEF'])
selected = set(filter(None, os.environ['DEPLOY_SERVICES'].split(',')))
digests = dict(
    line.split('=', 1)
    for line in os.environ['IMAGE_DIGESTS_LINES'].splitlines()
    if line.strip()
)
container_to_service = {
    'svc-productos': 'productos',
    'svc-ordenes': 'ordenes',
    'svc-stock': 'stock',
    'svc-gateway': 'gateway',
    'nginx': 'nginx',
    'migrations': 'migrations',
}
seen = set()
for container in data['containerDefinitions']:
    service = container_to_service.get(container['name'])
    if service in selected:
        if service not in digests:
            raise SystemExit(f'missing digest for selected service: {service}')
        container['image'] = (
            f\"{os.environ['ECR_BASE']}/{os.environ['PROJECT_NAME']}-{service}\"
            f\"@{digests[service]}\"
        )
        seen.add(service)
missing = selected - seen
if missing:
    raise SystemExit('selected services absent from current task definition: ' + ','.join(sorted(missing)))

for field in [
    'taskDefinitionArn', 'revision', 'status', 'requiresAttributes',
    'compatibilities', 'registeredAt', 'registeredBy',
]:
    data.pop(field, None)
print(json.dumps(data))
")

NEW_REVISION=$(aws ecs register-task-definition \
  --cli-input-json "${NEW_TASK_DEF}" \
  --region "${AWS_REGION}" \
  --query 'taskDefinition.taskDefinitionArn' \
  --output text)

echo "  Registered: ${NEW_REVISION}"

# Verify new revision images are exactly the selected immutable digests.
echo "  Verifying new revision images..."
VERIFY_DEF=$(aws ecs describe-task-definition --task-definition "${NEW_REVISION}" --region "${AWS_REGION}" --query 'taskDefinition.containerDefinitions[].{name:name,image:image}' --output json)
echo "  Images in new revision:"
echo "${VERIFY_DEF}" | python3 -c 'import json,sys; [print(f"    - {x[\"name\"]}: {x[\"image\"]}") for x in json.load(sys.stdin)]'
VERIFY_DEF_JSON="${VERIFY_DEF}" ECR_BASE="${ECR_BASE}" PROJECT_NAME="${PROJECT_NAME}" \
  DEPLOY_SERVICES="${DEPLOY_SERVICES}" IMAGE_DIGESTS_LINES="${IMAGE_DIGESTS_LINES}" \
  python3 -c "
import json
import os

images = {item['name']: item['image'] for item in json.loads(os.environ['VERIFY_DEF_JSON'])}
service_to_container = {
    'productos': 'svc-productos', 'ordenes': 'svc-ordenes', 'stock': 'svc-stock',
    'gateway': 'svc-gateway', 'nginx': 'nginx', 'migrations': 'migrations',
}
digests = dict(line.split('=', 1) for line in os.environ['IMAGE_DIGESTS_LINES'].splitlines() if line.strip())
for service in filter(None, os.environ['DEPLOY_SERVICES'].split(',')):
    container = service_to_container[service]
    expected = f\"{os.environ['ECR_BASE']}/{os.environ['PROJECT_NAME']}-{service}@{digests[service]}\"
    if images.get(container) != expected:
        raise SystemExit(f\"image verification failed for {service}: expected {expected}, got {images.get(container)}\")
"
echo "  Digest verification: selected images are immutable and match ECR."
echo ""

# --- Step 2: Update service and wait for stable deployment ---
echo "[2/3] Updating ECS service..."

PREV_REVISION=$(aws ecs describe-services --cluster "${CLUSTER_NAME}" --services "${SERVICE_NAME}" --region "${AWS_REGION}" --query 'services[0].taskDefinition' --output text || echo "unknown")
echo "  Previous task def: ${PREV_REVISION}"

aws ecs update-service \
  --cluster "${CLUSTER_NAME}" \
  --service "${SERVICE_NAME}" \
  --task-definition "${NEW_REVISION}" \
  --region "${AWS_REGION}" \
  --output text \
  --query 'service.serviceName' > /dev/null

echo "  Service updated. Waiting for deployment to stabilize (timeout 10m)..."
echo "  (If health checks fail, ECS will auto-rollback via circuit breaker — watch Events tab)"
echo ""

# Wait up to 10 minutes for runningCount == desiredCount with no in-progress deployments
set +e
aws ecs wait services-stable \
  --cluster "${CLUSTER_NAME}" \
  --services "${SERVICE_NAME}" \
  --region "${AWS_REGION}"
WAIT_CODE=$?
set -e

if [ "${WAIT_CODE}" -ne 0 ]; then
  echo "ERROR: wait services-stable timed out or failed (code ${WAIT_CODE}); deployment is not considered successful." >&2
  exit 1
else
  echo "  services-stable: OK"
fi

# --- Step 3: Detect rollback (Fase 7.7) ---
echo ""
echo "[3/3] Verifying deployment (rollback detection)..."

CURRENT_REVISION=$(aws ecs describe-services --cluster "${CLUSTER_NAME}" --services "${SERVICE_NAME}" --region "${AWS_REGION}" --query 'services[0].taskDefinition' --output text)
DEPLOYMENTS=$(aws ecs describe-services --cluster "${CLUSTER_NAME}" --services "${SERVICE_NAME}" --region "${AWS_REGION}" --query 'services[0].deployments[].taskDefinition' --output text)
EVENTS=$(aws ecs describe-services --cluster "${CLUSTER_NAME}" --services "${SERVICE_NAME}" --region "${AWS_REGION}" --query 'services[0].events[0:5].message' --output text 2>/dev/null || true)

echo "  Current task def: ${CURRENT_REVISION}"
echo "  Expected:         ${NEW_REVISION}"
echo "  Recent events:"
echo "${EVENTS}" | tr '\t' '\n' | head -n 5 | sed 's/^/    * /'

if [ "${CURRENT_REVISION}" != "${NEW_REVISION}" ]; then
  echo "ERROR: current task def != new revision — rollback likely occurred (circuit breaker)." >&2
  echo "  Expected ${NEW_REVISION}" >&2
  echo "  Got      ${CURRENT_REVISION}" >&2
  echo "  Check ECS console Events and CloudWatch logs /ecs/${PROJECT_NAME}-${ENVIRONMENT} for health failures." >&2
  exit 1
fi

# Check for circuit breaker message in events
if echo "${EVENTS}" | grep -qi "rollback\|circuit breaker\|failed"; then
  echo "WARN: events mention rollback/failure — verify but current revision matches expected, so deploy may have recovered." >&2
fi

echo ""
echo "=== Deploy complete — verified ==="
echo ""
echo "Task definition: ${NEW_REVISION}"
echo "Deployed tag:    ${IMAGE_TAG} — digests verified, no rollback detected."
echo ""
echo "Get the task public IP:"
echo "  TASK_ARN=\$(aws ecs list-tasks --cluster ${CLUSTER_NAME} --query 'taskArns[0]' --output text --region ${AWS_REGION})"
echo "  ENI_ID=\$(aws ecs describe-tasks --cluster ${CLUSTER_NAME} --tasks \$TASK_ARN --query 'tasks[0].attachments[0].details[?name==\`networkInterfaceId\`].value' --output text --region ${AWS_REGION})"
echo "  aws ec2 describe-network-interfaces --network-interface-ids \$ENI_ID --query 'NetworkInterfaces[0].Association.PublicIp' --output text --region ${AWS_REGION}"
echo ""
echo "Test endpoints:"
echo "  curl http://<PUBLIC_IP>/health"
echo "  curl http://<PUBLIC_IP>/api/productos/health"
echo "  curl http://<PUBLIC_IP>/api/ordenes/health"
echo "  curl http://<PUBLIC_IP>/api/stock/health"
