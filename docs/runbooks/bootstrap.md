# Runbook — Bootstrap de la identidad OIDC (GitHub Actions → AWS)

> El provider OIDC, el rol `*-github-actions` y su policy viven en
> `terraform/bootstrap/`, separados del stack de aplicación. Así el
> `terraform destroy` nocturno de `terraform/` ya no puede borrar las
> credenciales que usan todos los workflows.

## Por qué

Hasta este cambio, `terraform/cicd.tf` estaba dentro del stack de aplicación.
El teardown (`teardown.yml`) destruía todo, incluido el rol IAM. Desde la
primera destrucción, todos los workflows fallaban con:

```
Could not assume role with OIDC: The web identity token provided could not be validated.
```

El schedule quedó apagado por defecto (`vars.AUTO_CLEANUP_ENABLED != 'true'`)
para cortar los runs fallidos diarios hasta reparar la identidad.

## Setup inicial (cuenta nueva)

```bash
# 1) Bucket de state + tabla de lock (una vez por entorno)
./scripts/bootstrap-backend.sh erp-pipeline dev us-east-2

# 2) Aplicar la identidad
#    backend-bootstrap-<env>.hcl ya fija key = "bootstrap.tfstate".
cd terraform/bootstrap
terraform init -backend-config=../environments/backend-bootstrap-dev.hcl
terraform plan
terraform apply
terraform output github_actions_role_arn

# 3) Guardar el ARN como secreto del repo
gh secret set AWS_ROLE_ARN --body "<arn del paso 2>"
```

Después de esto, `pipeline.yml`, `terraform-plan.yml`, `teardown.yml` y el
deploy pueden asumir el rol otra vez.

## Migración desde el layout viejo (el rol ya existe en AWS)

El stack de aplicación tiene bloques `removed { lifecycle { destroy = false } }`
en `terraform/removed.tf`: al aplicar, Terraform **olvida** los recursos sin
borrarlos de AWS. Después se importan al stack de bootstrap.

Los backends de bootstrap viven en
`terraform/environments/backend-bootstrap-<env>.hcl` y ya incluyen
`key = "bootstrap.tfstate"`. Si un checkout viejo inicializó el backend con
`backend-<env>.hcl` + `-backend-config="key=bootstrap.tfstate"` manual, la
configuración resultante es la misma; para dejar de pasar la key a mano
ejecutá `terraform init -reconfigure -backend-config=../environments/backend-bootstrap-<env>.hcl`.
Si además cambiás de bucket, usá `-migrate-state` en lugar de `-reconfigure`.

```bash
# 1) Olvidar la identidad en el stack de aplicación (no la destruye)
cd terraform
terraform init -backend-config=environments/backend-dev.hcl
terraform apply        # removed.tf => destroy=false, no toca AWS

# 2) Importar en bootstrap
cd bootstrap
terraform init -backend-config=../environments/backend-bootstrap-dev.hcl

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

# Si el provider ya existe en la cuenta:
terraform import aws_iam_openid_connect_provider.github_actions \
  "arn:aws:iam::${ACCOUNT_ID}:oidc-provider/token.actions.githubusercontent.com"

# Si el rol ya existe:
terraform import aws_iam_role.github_actions "erp-pipeline-dev-github-actions"

# Policy inline del rol:
terraform import aws_iam_role_policy.github_actions \
  "erp-pipeline-dev-github-actions:github-actions-cicd"

terraform plan   # esperado: No changes
```

Si los recursos no existen (cuenta limpia o destroy previo), saltear los
`import` y ejecutar `terraform apply`.

## Verificación

```bash
cd terraform/bootstrap
terraform state list
# aws_iam_openid_connect_provider.github_actions
# aws_iam_role.github_actions
# aws_iam_role_policy.github_actions

terraform output github_actions_role_arn
```

Y desde GitHub:

```bash
gh secret list                      # AWS_ROLE_ARN presente

# Prueba de asunción de rol sin destruir nada (workflow manual, main only):
gh workflow run terraform-plan.yml -f environment=dev
gh run watch
```

El teardown manual requiere `confirm=destroy`; con `confirm=no` el job se
saltea (no sirve como prueba).

## Reactivar el destroy nocturno

Solo cuando el rol esté reparado y el secreto actualizado:

```bash
gh variable set AUTO_CLEANUP_ENABLED --body "true"
```

Para apagarlo de nuevo:

```bash
gh variable delete AUTO_CLEANUP_ENABLED
```

## Notas

- El stack de bootstrap se aplica **una vez por cuenta AWS**; el repo solo
  admite un `AWS_ROLE_ARN`.
- No agregar el provider/rol de vuelta a `terraform/cicd.tf`: volvería a
  quedar dentro del destroy.
- El provider, el rol y su policy tienen `lifecycle { prevent_destroy = true }`
  en `terraform/bootstrap/cicd.tf`; borrarlos requiere quitarlo a mano primero.
- El trust OIDC acepta `ref:refs/heads/main` y los subjects
  `environment:terraform-{dev,staging,prod}` / `environment:destroy` que GitHub
  emite para jobs con `environment:`. Sin estos últimos, el plan confiable y el
  teardown no pueden asumir el rol.
- El job `Terraform checks` valida `terraform/bootstrap` en cada PR sin
  backend ni credenciales.
