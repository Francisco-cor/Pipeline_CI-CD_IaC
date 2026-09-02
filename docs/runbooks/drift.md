# Runbook — Drift Detection & Remediation (Fase 7)

> Cómo detectar y corregir diferencias entre el estado deseado (Terraform) y el real (AWS).

## Qué es drift

Ejemplos:

- Alguien cambia `desired_count` manualmente en consola ECS
- `aws ecs update-service --task-definition` vía `deploy.sh` (esperado, `lifecycle ignore_changes`)
- Cambio manual de `sg_app` ingress o `rds backup_retention` en consola

## Detección

### 1. Local

```bash
cd terraform
terraform init -backend-config=environments/backend-dev.hcl
terraform plan -var-file=environments/dev.tfvars -no-color | tee plan.txt
# Busca "will be updated in-place" o "will be replaced"
grep -i "drift\|will be\|forces replacement" plan.txt
```

Para prod sin tocar dev:

```bash
terraform plan -var-file=environments/prod.tfvars -no-color | grep -E "Plan:|No changes"
# Esperado en dev después de Fase 7.1: "No changes" si no hay drift
terraform plan -var-file=environments/dev.tfvars -no-color
terraform plan -var-file=environments/prod.tfvars -no-color -detailed-exitcode; echo $?
# 0 = no changes, 2 = changes pending, 1 = error
```

### 2. CI — job `terraform` en PR

- `pipeline.yml:346-460` corre `fmt -check` → `validate` → `tflint` → `checkov` → `plan` en cada PR
- El `plan` se comenta en el PR (`marocchino/sticky-pull-request-comment@v2` header `terraform-plan`)
- Revisa el comentario: si hay `~ aws_ecs_service.app` con `taskDefinition` es normal (`ignore_changes`), si hay `aws_db_instance` con `deletion_protection` es drift real.

### 3. `ignore_changes` esperados (no son drift)

- `terraform/modules/compute/main.tf:389-393` `lifecycle { ignore_changes = [task_definition, desired_count] }`
  - `task_definition` cambia vía `deploy.sh` / GH Actions, no via `terraform apply` — **ignorado a propósito**
  - `desired_count` permite escalar manualmente sin Terraform — **ignorado**
- Por eso `terraform plan` en `dev` después de un deploy muestra `No changes` aunque la imagen haya cambiado.

## Remediación

### Drift legítimo (infra debe volver al código)

```bash
cd terraform
terraform init -backend-config=environments/backend-dev.hcl
terraform plan -var-file=environments/dev.tfvars -out=tfplan
terraform apply tfplan
# O con backend per env:
terraform apply -var-file=environments/prod.tfvars -target=aws_security_group.sg_app
```

### Drift esperado (deploy de imagen)

- No hacer `terraform apply` para `task_definition` — el `lifecycle ignore_changes` ya lo maneja
- Si `terraform plan` muestra diff solo en `task_definition`, ignóralo; el despliegue se gestiona por `deploy.sh`

### Drift en RDS con `deletion_protection=true` (prod)

```bash
# En prod, destroy está bloqueado (Fase 7.2 + 7.8)
# Si necesitas cambiar backup_retention o instancia:
terraform plan -var-file=environments/prod.tfvars
# Revisa si requiere replacement (forces replacement) — en prod eso es riesgoso
# Para cambios que requieren reemplazo, hacer snapshot manual primero:
aws rds create-db-snapshot --db-instance-identifier erp-pipeline-prod-postgres --db-snapshot-identifier pre-change-$(date +%Y%m%d)
```

## Prevención

- No editar infra manualmente en consola — todo via `terraform` + PR
- PRs requieren `terraform` job verde (`tflint` + `checkov` + `plan` comment)
- `teardown.yml:1-60` tiene prod guard (`if: environment != 'prod'`) — nunca destruye prod automáticamente
- `enable_deletion_protection=true` en `terraform/environments/prod.tfvars:12` + `terraform/modules/database/main.tf:115-118` impide `terraform destroy` accidental

## Verificación multi-env (Fase 7.1 métrica)

```bash
# Dev no debe tener diff cuando prod tiene cambios y viceversa
terraform init -backend-config=environments/backend-dev.hcl -reconfigure
terraform plan -var-file=environments/dev.tfvars -no-color | grep "No changes" && echo "dev clean"

terraform init -backend-config=environments/backend-prod.hcl -reconfigure
terraform plan -var-file=environments/prod.tfvars -no-color | grep "No changes" && echo "prod clean"

# O en una línea (Fase 7 métrica):
terraform -chdir=terraform plan -var-file=environments/prod.tfvars -no-color | head -n 20
terraform -chdir=terraform validate && tflint --chdir=terraform --recursive --format compact && echo "tflint 0 warnings"
```

## Troubleshooting

| Síntoma                                                     | Causa                                                           | Fix                                                                                   |
| ----------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `Error: bucket not found` al `init`                         | `-backend-config` incorrecto                                    | `terraform init -reconfigure -backend-config=environments/backend-dev.hcl` (Fase 7.1) |
| `plan` muestra `aws_db_instance` `deletion_protection` diff | `enable_deletion_protection` var desalineada con `environment`  | Revisa `environments/dev.tfvars:11` vs `prod.tfvars:12`                               |
| `tflint` warning `terraform_unused_declarations`            | variable declarada pero no usada en módulo                      | Revisa `terraform/modules/compute/variables.tf:1` y `main.tf`                         |
| `checkov` HIGH fail                                         | SG abierto `0.0.0.0/0` en `sg_app` 80/443 es esperado (ADR-001) | Añade `checkov:skip=CKV_AWS_260` si es falso positivo, o documenta en ADR             |

## Referencias

- `terraform/environments/*.tfvars` + `backend-*.hcl` (Fase 7.1)
- `terraform/variables.tf:30-60` toggles `enable_nat_gateway/deletion_protection/service_discovery`
- `terraform/modules/networking/main.tf:104-160` NAT toggle `count` pattern
- `terraform/modules/compute/main.tf:389` `ignore_changes`
- `docs/ARCHITECTURE.md:1` mapa de módulos
