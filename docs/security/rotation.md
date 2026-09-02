# Security — Rotation Runbook (Fase 8.5 + 8.6)

> Cómo rotar secretos y thumbprints sin downtime. Para fase 7 prod guards (`environments/prod.tfvars:12` `deletion_protection=true`).

## 1. OIDC Thumbprint Rotation (GitHub → AWS)

**Contexto:** `terraform/cicd.tf:18` usa `data.tls_certificate.github_actions` para obtener `sha1_fingerprint` de `https://token.actions.githubusercontent.com/.well-known/openid-configuration`. AWS requiere `thumbprint_list` en `aws_iam_openid_connect_provider.github_actions:27`.

**Cuando rotar:**

- GitHub rota su certificado OIDC (anuncio en GitHub Changelog, típico cada 1-2 años)
- `terraform plan` muestra `thumbprint_list` diff o `apply` falla con `InvalidThumbprint`
- Certificado intermedio de `token.actions.githubusercontent.com` expira (lee `openssl s_client -connect token.actions.githubusercontent.com:443 -showcerts`)

**Rotación automática (actual):**

- `data.tls_certificate` fetcha el thumbprint en cada `plan/apply` — si GitHub rota, el data source trae el nuevo automáticamente y `plan` propone actualizar el `aws_iam_openid_connect_provider`.
- No hay thumbprint hardcodeado; el `sha1_fingerprint` es dinámico.

**Rotación manual (si estuviera hardcodeado):**

```bash
# 1. Obtener nuevo thumbprint
echo | openssl s_client -connect token.actions.githubusercontent.com:443 -servername token.actions.githubusercontent.com 2>/dev/null | openssl x509 -fingerprint -sha1 -noout | cut -d= -f2 | tr -d :
# o
terraform -chdir=terraform apply -target=data.tls_certificate.github_actions
terraform -chdir=terraform plan # debe mostrar thumbprint nuevo

# 2. Aplicar
terraform -chdir=terraform apply -var-file=environments/prod.tfvars

# 3. Verificar OIDC funciona
# Push a main → pipeline `Configure AWS credentials via OIDC` debe pasar sin InvalidThumbprint
```

**Least-privilege por env (Fase 8.5):**

- `cicd.tf:56` `condition StringLike sub` ahora es dinámico:
  - `prod`: solo `repo:owner/repo:ref:refs/heads/main` (no `pull_request` — plan prod se hace local, no en PR)
  - `dev/staging`: `ref:refs/heads/main` + `pull_request` (plan PR permitido)
- Esto reduce blast radius: un PR malicioso no puede asumir el rol `prod`.

**Checklist post-rotación:**

- [ ] `terraform plan -var-file=environments/prod.tfvars` sin drift de thumbprint
- [ ] Push a `main` verde en `Configure AWS credentials`
- [ ] PR a `main` en `dev` verde en `terraform` job (OIDC `pull_request`)

---

## 2. SSM Parameter Rotation (`/erp/*/db-url`)

**Recursos:** `terraform/modules/secrets/main.tf:23` `aws_ssm_parameter.db_url` (`SecureString` + `kms:Decrypt` en `ecs_task_execution_secrets:73`)

**Rotación manual de DATABASE_URL (sin recrear RDS):**

```bash
# Opción A: rotar solo la URL si cambiaste endpoint/creds fuera de TF
aws ssm put-parameter --name /erp/prod/db-url --type SecureString --value "postgresql://erpadmin:NEW_PASS@erp-prod-postgres.xxx.us-east-2.rds.amazonaws.com:5432/erpdb" --overwrite --region us-east-2
# Forzar nuevo deployment ECS para que los containers lean el nuevo SSM value
aws ecs update-service --cluster erp-pipeline-prod-cluster --service erp-pipeline-prod-service --force-new-deployment

# Opción B: rotar password del RDS (generado por random_password)
# Terraform gestiona random_password.db_password:30 — taint para regenerar
terraform -chdir=terraform taint 'module.database.random_password.db_password'
terraform -chdir=terraform apply -var-file=environments/prod.tfvars
# Esto: 1) genera nuevo password, 2) actualiza aws_db_instance, 3) actualiza aws_ssm_parameter.db_url, 4) requiere redeploy ECS
# Verifica:
aws ssm get-parameter --name /erp/prod/db-url --with-decryption --query Parameter.Value --output text
```

**Rotación automática futura (Fase 8.6 lambda):**

- Crear `aws_ssm_parameter` con `rotation` via Lambda o AWS Secrets Manager rotation (no SSM nativo).
- Placeholder: `terraform/modules/secrets/lambda_rotation.tf` (a implementar) invocaría `lambda` cada 30d que genera nuevo `random_password` y hace `modify-db-instance`.
- Por ahora, rotación es manual y documentada aquí; `checkov` exige `kms:Decrypt` ya añadido (`secrets/main.tf:86`).

---

## 3. RDS Master Password Rotation

- `terraform/modules/database/main.tf:27` `random_password.db_password` `length 32` `override_special`
- Rotation = `taint` + `apply` como arriba. En prod, `deletion_protection=true` no bloquea `modify-db-instance`, solo `destroy`.
- Backup: snapshot manual antes de rotar si es prod:

  ```bash
  aws rds create-db-snapshot --db-instance-identifier erp-pipeline-prod-postgres --db-snapshot-identifier pre-rotation-$(date +%Y%m%d)
  ```

---

## 4. ECR Image Scanning + npm audit (Fase 8.7)

- `pipeline.yml:182` `trivy fs` + `trivy-image` + `npm audit` (ver `pipeline.yml:150` `audit` job) fallan si `HIGH`/`CRITICAL` sin fix.
- Rotación de base image (`node:20-alpine`) via `renovate.json:1` + `dependabot.yml:1` weekly.

---

## 5. Verificación

```bash
# OIDC thumbprint actual
terraform -chdir=terraform output github_actions_role_arn
# SSM param existe y es SecureString
aws ssm describe-parameters --parameter-filters Key=Name,Values=/erp/dev/db-url --query 'Parameters[0].Type'
# IAM policy tiene GetParameter + kms:Decrypt
aws iam get-role-policy --role-name erp-pipeline-dev-ecs-task-execution-role --policy-name allow-get-specific-secrets --query PolicyDocument
# Prod no permite pull_request
terraform -chdir=terraform plan -var-file=environments/prod.tfvars | grep github_actions_assume
```

## Referencias

- `terraform/cicd.tf:18-65` OIDC provider + trust `StringLike sub` least-privilege
- `terraform/modules/secrets/main.tf:73-92` SSM `GetParameter/GetParameters` + `kms:Decrypt` con `ViaService` condition
- `terraform/modules/database/main.tf:27` random_password
- `docs/adr/ADR-002-oidc-github-actions.md:1` ADR OIDC
