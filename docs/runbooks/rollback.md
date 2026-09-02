# Runbook — Rollback (Fase 7.7 + ADR-001)

> Cómo volver a una revisión estable cuando un deploy falla (manual o automático).

## Rollback automático (preferido)

ECS lo hace solo:

- `terraform/modules/compute/main.tf:375-378` `deployment_circuit_breaker { enable=true rollback=true }`
- Si la nueva task falla `healthCheck` (`wget -qO- http://localhost:300x/health`) dentro de `health_check_grace_period_seconds=120`, ECS marca deployment `FAILED` y restaura `taskDefinition` previo.
- `scripts/deploy.sh:150-180` lo detecta: compara `CURRENT_REVISION != NEW_REVISION` + eventos con `rollback`.

**No requiere acción.** Verifica:

```bash
aws ecs describe-services --cluster erp-pipeline-dev-cluster --services erp-pipeline-dev-service --query 'services[0].deployments'
aws ecs describe-services --cluster erp-pipeline-dev-cluster --services erp-pipeline-dev-service --query 'services[0].events[0:5].message'
```

Si ves `"service ... has reverted to task definition ... due to circuit breaker"`, el rollback ya ocurrió.

## Rollback manual — a revisión conocida

Si necesitas volver a un `sha` anterior (ej. `sha-a1b2c3d`):

```bash
export ENVIRONMENT=dev PROJECT_NAME=erp-pipeline AWS_REGION=us-east-2
# Opción A: re-deploy via deploy.sh con tag previo (imágenes aún en ECR si ecr_image_retention_count=5)
IMAGE_TAG=sha-a1b2c3d bash scripts/deploy.sh

# Opción B: rollback directo via AWS CLI (sin re-registrar)
PREV_TD=$(aws ecs describe-services --cluster erp-pipeline-dev-cluster --services erp-pipeline-dev-service --query 'services[0].deployments[1].taskDefinition' --output text)
# Si no hay deployments[1], lista revisiones:
aws ecs list-task-definitions --family-prefix erp-pipeline-dev-app --sort DESC --max-items 5
# Usa una revisión ARNs conocida:
ROLLBACK_TD="arn:aws:ecs:us-east-2:123456789012:task-definition/erp-pipeline-dev-app:41"
aws ecs update-service --cluster erp-pipeline-dev-cluster --service erp-pipeline-dev-service --task-definition $ROLLBACK_TD
aws ecs wait services-stable --cluster erp-pipeline-dev-cluster --services erp-pipeline-dev-service
```

### Verificación post-rollback

```bash
# Task def actual debe ser el rollback target
aws ecs describe-services --cluster erp-pipeline-dev-cluster --services erp-pipeline-dev-service --query 'services[0].taskDefinition'

# Health
IP=$(aws ec2 describe-network-interfaces --network-interface-ids $(aws ecs describe-tasks --cluster erp-pipeline-dev-cluster --tasks $(aws ecs list-tasks --cluster erp-pipeline-dev-cluster --query 'taskArns[0]' --output text) --query 'tasks[0].attachments[0].details[?name==`networkInterfaceId`].value' --output text) --query 'NetworkInterfaces[0].Association.PublicIp' --output text)
curl -sf http://$IP/health && curl -sf http://$IP/api/v1/productos/health
```

## Rollback via Terraform (solo si el estado drift)

```bash
cd terraform
terraform init -backend-config=environments/backend-dev.hcl
terraform plan -var-file=environments/dev.tfvars
# Si el servicio fue movido por deploy.sh, Terraform muestra ignore_changes:
#   # aws_ecs_service.app will be updated in-place
#   ~ task_definition = "arn:...:42" -> "arn:...:41" (ignore_changes)
# No hagas terraform apply para revertir el servicio — usa aws ecs update-service arriba.
# Terraform solo gestiona infra, no la versión de la imagen (lifecycle ignore_changes).
```

## Retención ECR y ventana de rollback

- `terraform/environments/dev.tfvars:14` `ecr_image_retention_count=5` (Fase 7.5) + `terraform/modules/compute/main.tf:46-76` lifecycle `countNumber = var.ecr_image_retention_count`
- Mantiene las últimas 5 imágenes `sha-*` + `latest`/`v*`. Con 5 puedes volver hasta 4 deploys atrás sin rebuild.
- Si `countNumber=1` (antiguo) solo quedaba `latest`, imposible rollback a `sha` previo — **Fase 7.5 lo corrige**.

## Cuándo hacer rollback manual vs esperar auto

| Escenario                                                       | Acción                                                                                 |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Nueva imagen falla `health` inmediatamente                      | Espera 2-3m, `circuit_breaker` hará rollback solo — verifica con `deploy.sh`           |
| Imagen pasa `health` pero bug funcional (500 en `/api/ordenes`) | Rollback manual a `sha` previo con `IMAGE_TAG=sha-prev bash scripts/deploy.sh`         |
| Migración falló (`migrations` exit 1)                           | Task no arranca, `circuit breaker` dispara — corrige `sql/*.sql`, rebuild `migrations` |
| Prod con `deletion_protection=true`                             | `terraform destroy` bloqueado — rollback solo via `update-service`, nunca destroy      |

## Post-mortem checklist

- [ ] `aws logs tail /ecs/erp-pipeline-dev --log-stream-name-prefix productos` → causa 5xx
- [ ] `SELECT * FROM schema_migrations` → migración aplicada?
- [ ] `trivy-image` SARIF en GH Actions → vuln crítica en la imagen?
- [ ] `checkov/tflint` verde en PR? Si drift infra, ver `docs/runbooks/drift.md`

## Referencias

- `terraform/modules/compute/main.tf:345-400` ECS service `circuit_breaker` + `lifecycle ignore_changes`
- `scripts/deploy.sh:130-180` verify + rollback detection
- `docs/runbooks/deploy.md:1` deploy normal
