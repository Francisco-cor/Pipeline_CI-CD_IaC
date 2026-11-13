# Security — Rotation Runbook (Fase 8.5 + 8.6)

> Cómo rotar secretos y thumbprints sin downtime. Para fase 7 prod guards (`environments/prod.tfvars:12` `deletion_protection=true`).

## 1. OIDC Thumbprint Rotation (GitHub → AWS)

**Contexto:** `terraform/bootstrap/cicd.tf:18` usa `data.tls_certificate.github_actions` para obtener `sha1_fingerprint` de `https://token.actions.githubusercontent.com/.well-known/openid-configuration`. AWS requiere `thumbprint_list` en `aws_iam_openid_connect_provider.github_actions:27`.

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

- `bootstrap/cicd.tf:56` `condition StringLike sub` queda limitado a
  `repo:owner/repo:ref:refs/heads/main` para todos los entornos.
- Los PR ejecutan únicamente validaciones estáticas sin credenciales AWS; el plan
  con backend remoto se solicita en el workflow confiable manual y protegido.
- Esto reduce blast radius: un PR malicioso no puede asumir el rol de CI/CD.

**Checklist post-rotación:**

- [ ] `terraform plan -var-file=environments/prod.tfvars` sin drift de thumbprint
- [ ] Push a `main` verde en `Configure AWS credentials`
- [ ] PR a `main` verde en el job `Terraform checks` (sin OIDC ni backend remoto)
- [ ] Plan remoto ejecutado desde `Terraform trusted plan` con el environment protegido

---

## 2. SSM Parameter Rotation (`/erp/*/db-url`)

**Recursos:** `terraform/modules/secrets/main.tf:23` `aws_ssm_parameter.db_url` (`SecureString` + customer-managed KMS opcional en `terraform/kms.tf:1` + `kms:Decrypt` en `ecs_task_execution_secrets:73`)

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
- Por ahora, la contraseña continúa con rotación manual; la CMK sí queda provisionada y rotada automáticamente por KMS cuando `enable_customer_managed_kms=true`.

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

- `pipeline.yml` (`trivy-fs`, `trivy-image`, `audit`) falla si hay `HIGH`/`CRITICAL` sin fix. El gate de `audit` es `npm audit --omit=dev --audit-level=high` sobre el lock raíz y los de `services/*`; la política es 0 HIGH en dependencias de producción. `zod` se mantiene en la línea `^4` usada por `packages/shared/src/validate.js`.
- Rotación de base image (`node:24-alpine`) via `.github/dependabot.yml:1` mensual (grupos por directorio; majors de Node ignorados a propósito).

---

## 5. JWT signing keys (`JWT_SECRET` / `JWT_PUBLIC_KEY`)

- HS256 uses `JWT_SECRET`; RS256 uses `JWT_PUBLIC_KEY` in the services and the
  private key stays with the issuer. RS256 is preferred when more than one
  service or team must verify tokens.
- Rotation (HS256): create the new secret, deploy it to the identity issuer and
  every service, wait for old tokens to expire, then remove the old secret.
  Tokens signed with the old secret remain valid until `exp`; plan the overlap
  window accordingly.
- Rotation (RS256): publish a new key pair, add the new public key to
  `JWT_PUBLIC_KEY`, switch the issuer to the new private key, and retire the old
  public key after the maximum token lifetime.
- Never commit either key. In AWS, store them in SSM `SecureString` (or Secrets
  Manager) and inject them with ECS `secrets`, not plain environment values.
  This repository generates an HS256 secret and stores it at
  `/erp/<env>/jwt-secret`; retrieve it only for controlled token issuance:
  `aws ssm get-parameter --name /erp/prod/jwt-secret --with-decryption --query Parameter.Value --output text`.
- Prod startup fails closed (`assertAuthConfig`) if `AUTH_ENABLED` is on without
  a verification key; do not 'fix' an outage by disabling auth.

## 6. Redis AUTH token (`/erp/<env>/redis-url`)

- `terraform/cache.tf` generates `random_password.redis_auth` and writes the
  full `rediss://:<token>@<endpoint>:6379` URL to SSM as a `SecureString`.
- The ECS task execution role can read only the DB and Redis parameter ARNs
  (`modules/secrets/main.tf`); the application receives `REDIS_URL` via
  `secrets`, not `environment`.
- Rotation: `terraform taint 'random_password.redis_auth[0]'` + apply. This
  replaces the replication group `auth_token`, updates the SSM value and
  requires a new ECS deployment (`aws ecs update-service --force-new-deployment`).
  Expect a short cache-cold window; the app falls back to memory or misses.
- `transit_encryption_enabled` and `at_rest_encryption_enabled` are both true;
  `rediss://` is mandatory. A `redis://` URL will fail the handshake.

## 7. SNS alert subscription

`prod.tfvars` requires a real `alert_email`; the Terraform precondition rejects
empty values and `example.com/org/net`. After `apply`, AWS sends a subscription
confirmation email. Alarms do not deliver notifications until that link is
clicked. Check the topic subscription status:

```bash
aws sns list-subscriptions-by-topic --topic-arn <topic-arn> \
  --query 'Subscriptions[].SubscriptionArn'
```

## 8. Database roles `erp_app` / `erp_migrator` (PENDING)

The target design is two least-privilege roles instead of using the RDS master
user for everything:

- `erp_migrator`: owns DDL, runs the one-shot `migrations` container, no
  application traffic.
- `erp_app`: DML only (`SELECT/INSERT/UPDATE/DELETE` on application tables,
  `USAGE` on sequences), used by the four services. No `CREATE`, no ownership.
- Separate Terraform `random_password` values and separate SSM parameters
  (`db-app-url`, `db-migrator-url`); the execution role reads both, each
  container gets only its own URL.

Why it is not implemented yet: creating roles and grants requires an
administrative connection after RDS is available. The current migration
container connects with `DATABASE_URL` and has no separate bootstrap step; doing
this safely needs an idempotent `CREATE ROLE ... IF NOT EXISTS` bootstrap
(psql/Lambda/Vault) plus a verification that every table/sequence is covered,
otherwise a missed grant causes a production outage. This should be delivered
as its own change with a staging rehearsal. Until then, the single RDS user is
documented as a known gap and the migration/service boundary is enforced only by
process, not by the database.

## 9. Pending product-security work

- **Tenant row-level security:** `tenant_id` is only in JWT/audit today; tables
  do not have a tenant column or RLS policies. A real multi-tenant isolation
  requires schema changes plus `SET LOCAL app.tenant_id` per transaction.
- **Automatic secret rotation:** DB/Redis/JWT rotation is manual (taint + apply).
  Planned path is Secrets Manager rotation Lambdas or an external operator.
- **Audit retention/immutability:** `audit_log` currently lives in the primary
  database with no retention job or WORM export. Recommended: monthly export to
  S3 Object Lock + a retention policy.
- **Diagnostics network allowlist:** prod returns 404 at NGINX. If internal
  scraping is needed later, add a private listener or CIDR allowlist instead of
  re-enabling public routes.

## 10. Verificación

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

- `terraform/bootstrap/cicd.tf:18-65` OIDC provider + trust `StringLike sub` least-privilege
- `terraform/kms.tf:1` + `terraform/modules/secrets/main.tf:73-92` CMK opcional, SSM `GetParameter/GetParameters` y `kms:Decrypt` con `ViaService` condition
- `terraform/modules/database/main.tf:27` random_password
- `docs/adr/ADR-002-oidc-github-actions.md:1` ADR OIDC
