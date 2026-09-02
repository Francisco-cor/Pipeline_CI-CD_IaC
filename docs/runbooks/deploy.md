# Runbook — Deploy (Fase 7.7)

> Cómo desplegar una nueva imagen de forma segura con `deploy.sh` hardened y pipeline CI/CD.

## Prerrequisitos

- `IMAGE_TAG` existe en ECR (`scripts/build.sh` previo o pipeline `build` verde)
- AWS CLI con `sts:AssumeRoleWithWebIdentity` o perfil con `ecs:*` + `ecr:DescribeImages`
- `ENVIRONMENT` correcto (`dev` vs `prod` — prod tiene `deletion_protection=true` en `terraform/environments/prod.tfvars:12`)

## Deploy via CI/CD (recomendado)

1. Push a `main` → pipeline `build` (`docker/build-push-action@v6` `cache-from/to: type=gha`) solo si `dorny/paths-filter` detecta cambios (`pipeline.yml:58-107`)
2. `trivy-image` escanea `CRITICAL,HIGH` (soft-fail)
3. `deploy` job ejecuta:

   ```bash
   aws sts get-caller-identity # verifica OIDC
   IMAGE_TAG=sha-<short> bash scripts/deploy.sh
   ```

## Deploy manual (hotfix)

```bash
export AWS_REGION=us-east-2 PROJECT_NAME=erp-pipeline ENVIRONMENT=dev
# 1. Build y push (si no viene de CI)
GIT_SHA=$(git rev-parse --short HEAD) bash scripts/build.sh

# 2. Deploy con lock + verify + digest
IMAGE_TAG=sha-$GIT_SHA bash scripts/deploy.sh

# Salida esperada:
#   [0/3] Verifying images ... OK digest sha256:abc...
#   [1/3] Registered: arn:aws:ecs:...:task-definition/erp-pipeline-dev-app:42
#   [2/3] Updating ECS service...
#   services-stable: OK
#   [3/3] Verifying deployment ... no rollback detected
```

## Qué verifica `deploy.sh:1-200` (Fase 7.7)

| Paso            | Check                                                                                                                   | Fail → acción                                                |
| --------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Lock            | `flock /tmp/erp-deploy-<env>.lock` o `mkdir`                                                                            | `ERROR another deploy holds lock` → espera o `rm` lock stale |
| Tag format      | regex `sha-[0-9a-f]{4,40}`                                                                                              | WARN pero continúa                                           |
| ECR verify      | `aws ecr describe-images --image-ids imageTag=$TAG` por cada `productos/ordenes/stock/nginx/migrations` + `imageDigest` | `MISSING` → aborta, `build.sh` primero                       |
| Register        | `describe-task-definition` → python swap `image` → `register-task-definition`                                           | si JSON inválido → `ROLLBACK`                                |
| Digest verify   | `describe-task-definition $NEW_REVISION` → grep `$TAG`                                                                  | mismatch → aborta                                            |
| Update          | `update-service --task-definition $NEW_REVISION`                                                                        | si `AccessDenied` → revisa `cicd.tf:118` `ECSServiceDeploy`  |
| Wait            | `aws ecs wait services-stable` (10m timeout)                                                                            | timeout → `WARN` + sigue a verificar                         |
| Rollback detect | `describe-services` `taskDefinition` vs `NEW_REVISION` + `events` grep `rollback\|circuit breaker`                      | mismatch → `ERROR rollback likely` + exit 1                  |

## Rollback automático

- `terraform/modules/compute/main.tf:375` `deployment_circuit_breaker { rollback=true }`
- Si `healthCheck` falla > `health_check_grace_period_seconds=120` y `circuit breaker` dispara, ECS revierte a `PREV_REVISION` sin intervención.
- `deploy.sh` lo detecta en `[3/3]` comparando `CURRENT_REVISION != NEW_REVISION`.

## Verificación post-deploy

```bash
# IP pública de la task
TASK_ARN=$(aws ecs list-tasks --cluster erp-pipeline-dev-cluster --query 'taskArns[0]' --output text)
ENI_ID=$(aws ecs describe-tasks --cluster erp-pipeline-dev-cluster --tasks $TASK_ARN --query 'tasks[0].attachments[0].details[?name==`networkInterfaceId`].value' --output text)
IP=$(aws ec2 describe-network-interfaces --network-interface-ids $ENI_ID --query 'NetworkInterfaces[0].Association.PublicIp' --output text)
curl -sf http://$IP/health && echo "nginx ok"
curl -sf http://$IP/api/productos/health | jq
curl -sf http://$IP/api/v1/productos | jq '.data | length'

# Logs
aws logs tail /ecs/erp-pipeline-dev --follow
# O filtrar por servicio
aws logs tail /ecs/erp-pipeline-dev --log-stream-name-prefix productos --follow
```

## Troubleshooting

| Síntoma                          | Causa                                    | Fix                                                                                   |
| -------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------- |
| `MISSING` image                  | `build.sh` no pusheó ese tag             | `bash scripts/build.sh` + verifica `aws ecr describe-images`                          |
| `another deploy holds lock`      | deploy concurrent (CI + manual)          | `ps aux                                                                               | grep deploy.sh`+`rm /tmp/erp-deploy-dev.lock` si stale |
| `wait services-stable timed out` | health check falla o `startPeriod` corto | `aws ecs describe-services --cluster ... --services ... --query 'services[0].events'` |
| `rollback likely`                | circuito disparado                       | `aws ecs describe-services` + `aws logs tail` + revisar `migrations` exit code        |

## Finanzas

- `enable_nat_gateway=false` (default `environments/dev.tfvars:10`) mantiene $0 NAT
- Para `prod` con `enable_nat_gateway=true` + `enable_service_discovery=true` (Fase 7.3/7.6), coste NAT ~$32/mes + EIP. Habilitar solo cuando `private subnets` + `ALB` estén listos (Fase 10).

## Referencias

- `terraform/modules/compute/main.tf:143-200` task def + `templates/taskdef.json.tftpl:1`
- `scripts/deploy.sh:1-200` hardened flow
- `docs/data-model.md:1` triggers `updated_at` + stock invariant
