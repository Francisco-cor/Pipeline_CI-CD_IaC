# Runbook — Restore y Disaster Recovery (DR)

> RTO/RPO, escenarios de recuperación y drill reproducible. Script: `scripts/restore-drill.sh`. Alarmas: `docs/runbooks/alert.md`.

## 1. Objetivos

| Entorno | RPO objetivo | RTO objetivo | Mecanismo                                    | Frecuencia de drill |
| ------- | ------------ | ------------ | -------------------------------------------- | ------------------- |
| dev     | ≤ 24h        | ≤ 4h         | Snapshot automático (retención 1 día)        | a demanda           |
| staging | ≤ 24h        | ≤ 4h         | Snapshot automático (retención 1 día)        | mensual             |
| prod    | **≤ 15 min** | **≤ 2h**     | PITR continuo (retención 7 días) + snapshots | **trimestral**      |

- **RPO real**: `now - LatestRestorableTime` en modo PITR, o `now - SnapshotCreateTime` en modo snapshot. RDS publica un `LatestRestorableTime` que suele estar 5 minutos por detrás; el objetivo de 15 min cubre esa latencia más el tiempo de detección.
- **RTO real**: desde que se autoriza el restore hasta que las validaciones SQL pasan. Incluye provisión de la instancia scratch, espera de `available`, DNS y checks. No incluye la detección ni la comunicación.
- El RTO de 2h asume una instancia scratch del mismo tamaño que producción. Restaurar con una clase menor acelera la creación pero invalida la medición de rendimiento; el drill usa `db.t3.micro` por coste y lo documenta.

## 2. Escenarios

### A. Corrupción lógica o borrado accidental (PITR)

Un `DELETE`, una migración fallida o un bug escribió datos incorrectos. La instancia original sigue viva, pero el contenido está mal.

1. **No reinicies ni borres la instancia original.** Es la fuente del PITR y la evidencia.
2. Elegí un `restore-time` **anterior** al evento dañino, con margen (por ejemplo, 2 minutos antes del primer síntoma).
3. Restaurá a una instancia scratch, validá y recién entonces promové o extraé las filas necesarias.

### B. Pérdida total de la instancia (snapshot)

La instancia fue borrada, quedó inaccesible o la región/AZ falló. En prod con Multi-AZ, un fallo de AZ se resuelve solo con el failover de RDS; un fallo lógico o de datos requiere snapshot.

1. Identificá el snapshot automático más reciente y disponible.
2. Restaurá a una instancia scratch en la misma VPC.
3. Validá y promové.

### C. DR de región (futuro, fuera de Fase 3A)

Requiere réplica cross-region o copia de snapshots a otra región, Route 53 failover y replicación de secretos. Hoy el runbook cubre recuperación en la misma región. No ejecutar un failover de región sin un plan aprobado.

### D. Recuperación selectiva de una tabla

Si solo se perdió una tabla, restaurar la instancia completa es más lento pero más seguro. Alternativa: restaurar el scratch, `pg_dump -t <tabla>` y aplicar el dump en la original dentro de una transacción revisada.

## 3. Prerrequisitos

- AWS CLI v2 con credenciales que puedan: `rds:DescribeDBInstances`, `rds:DescribeDBSnapshots`, `rds:RestoreDBInstanceToPointInTime`, `rds:RestoreDBInstanceFromDBSnapshot`, `rds:AddTagsToResource`, `rds:ListTagsForResource`, `rds:DeleteDBInstance`, `ssm:GetParameter` (con `--with-decryption`) y `kms:Decrypt` si el parámetro usa CMK.
- `jq`, `psql` (cliente PostgreSQL 15+) y `python3`.
- Acceso de red desde el host del drill al puerto 5432 de la instancia scratch. El restore usa el **mismo security group y subnet group** que la instancia original; si el operador no está en la VPC, ejecutar desde un bastión/runner con acceso y no abrir el SG a internet.
- `terraform output -raw rds_instance_identifier` para confirmar el identificador (o `SOURCE_IDENTIFIER`).
- Aprobación explícita del owner para prod. El script exige `--environment prod --confirm-prod`.

## 4. Drill automatizado

`scripts/restore-drill.sh` es **dry-run por defecto**. No crea ni borra nada sin `--execute`.

### 4.1 Dry-run (siempre primero)

```bash
# Imprime el plan, valida herramientas y muestra el último restore point/snapshot
bash scripts/restore-drill.sh

# Prod: el dry-run no toca nada, pero muestra el guard que se exigirá al ejecutar
bash scripts/restore-drill.sh --environment prod --mode pitr

# Snapshot en vez de PITR
bash scripts/restore-drill.sh --mode snapshot
```

Salida esperada: fuente, modo, identificador scratch, restore point, clase, subnet group, SG, y checklist de prerequisitos. Si falta AWS CLI o credenciales, el dry-run lo advierte y sigue; `--execute` aborta.

### 4.2 Execute (dev/staging)

```bash
bash scripts/restore-drill.sh --execute --mode pitr
```

El script:

1. Verifica credenciales y que la instancia fuente exista.
2. Elige `LatestRestorableTime` (PITR) o el snapshot automático más reciente (snapshot).
3. Crea una instancia **nueva** con identificador `<source>-drill-<UTC>`; nunca modifica la original.
4. Etiqueta la instancia con `RestoreDrill=true`, `CreatedBy=restore-drill.sh`, `SourceInstance=<source>`.
5. Espera `available` y valida con SQL.
6. Imprime RTO, RPO y una fila Markdown para la tabla de evidencia.

Opciones útiles:

```bash
# Punto de restauración explícito (incidente real o simulacro de corrupción)
bash scripts/restore-drill.sh --execute --restore-time 2026-11-13T03:59:00Z

# Elegir clase/tamaño para medir RTO comparable con prod
bash scripts/restore-drill.sh --execute --instance-class db.t3.small

# Crear, validar y limpiar en la misma corrida
bash scripts/restore-drill.sh --execute --cleanup
```

### 4.3 Execute en prod

```bash
# Requiere AMBOS flags; sin --confirm-prod el script aborta antes de llamar a AWS
bash scripts/restore-drill.sh --environment prod --confirm-prod --execute --mode pitr
```

El restore de prod crea una instancia scratch facturable. No promueve nada automáticamente: la promoción es una decisión humana con ventana de cambio.

### 4.4 Limpieza

```bash
# Borra SOLO instancias scratch creadas por este script para el entorno.
# Verifica identificador, tag RestoreDrill y CreatedBy antes de borrar.
bash scripts/restore-drill.sh --environment dev --cleanup
```

El script no borra instancias que no tengan un state file propio en `${TMPDIR:-/tmp}/erp-restore-drills/`, que no empiecen con `<source>-drill-`, o cuyos tags no coincidan. Tampoco borra la instancia original.

## 5. Restore manual (si el script no aplica)

### 5.1 PITR

```bash
export AWS_REGION=us-east-2
SOURCE=erp-pipeline-prod-postgres
DRILL="${SOURCE}-drill-$(date -u +%Y%m%d%H%M%S)"

# 1. Ver la ventana restaurable
aws rds describe-db-instances --db-instance-identifier "$SOURCE" \
  --query 'DBInstances[0].{status:DBInstanceStatus,latest:LatestRestorableTime,class:DBInstanceClass,subnet:DBSubnetGroup.DBSubnetGroupName,sg:VpcSecurityGroups[].VpcSecurityGroupId,pg:DBParameterGroups[0].DBParameterGroupName}'

# 2. Restaurar a scratch (misma VPC, sin Multi-AZ, sin deletion protection)
aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier "$SOURCE" \
  --target-db-instance-identifier "$DRILL" \
  --restore-time "$(date -u -d '-5 minutes' +%Y-%m-%dT%H:%M:%SZ)" \
  --db-instance-class db.t3.micro \
  --db-subnet-group-name erp-pipeline-prod-db-subnet-group \
  --vpc-security-group-ids sg-xxxxxxxx \
  --db-parameter-group-name erp-pipeline-prod-pg15-xxxxxxxx \
  --no-publicly-accessible --no-multi-az --no-deletion-protection

# 3. Esperar y obtener endpoint
aws rds wait db-instance-available --db-instance-identifier "$DRILL"
aws rds describe-db-instances --db-instance-identifier "$DRILL" \
  --query 'DBInstances[0].Endpoint.Address' --output text
```

### 5.2 Snapshot

```bash
SNAP=$(aws rds describe-db-snapshots --db-instance-identifier "$SOURCE" --snapshot-type automated \
  --query 'reverse(sort_by(DBSnapshots,&SnapshotCreateTime))[0].DBSnapshotIdentifier' --output text)

aws rds restore-db-instance-from-db-snapshot \
  --db-instance-identifier "$DRILL" \
  --db-snapshot-identifier "$SNAP" \
  --db-instance-class db.t3.micro \
  --db-subnet-group-name erp-pipeline-prod-db-subnet-group \
  --vpc-security-group-ids sg-xxxxxxxx \
  --db-parameter-group-name erp-pipeline-prod-pg15-xxxxxxxx \
  --no-publicly-accessible --no-multi-az --no-deletion-protection
```

### 5.3 Conexión y validación

El endpoint cambia, las credenciales no. Obtené el `DATABASE_URL` desde SSM y reemplazá el host:

```bash
DB_URL=$(aws ssm get-parameter --name /erp-pipeline/prod/db-url --with-decryption \
  --query Parameter.Value --output text)
# El password y el usuario son los mismos; solo cambia el host.
# Evitá pegar el password en el shell history: usar PGPASSWORD o un .pgpass temporal.
```

Validaciones mínimas (todas deben pasar antes de promover):

```sql
-- 1. Conectividad y versión
SELECT version();

-- 2. Esquema completo: 8 tablas base (incluye schema_migrations)
SELECT count(*) AS tablas
FROM information_schema.tables
WHERE table_schema = 'public' AND table_type = 'BASE TABLE';

-- 3. Migraciones aplicadas y checksum registrado
SELECT count(*) AS migraciones FROM schema_migrations;
SELECT version, applied_at FROM schema_migrations ORDER BY version DESC LIMIT 5;

-- 4. Volumen de datos (comparar con la línea base del ticket)
SELECT 'productos' AS tabla, count(*) FROM productos
UNION ALL SELECT 'ordenes', count(*) FROM ordenes
UNION ALL SELECT 'movimientos_stock', count(*) FROM movimientos_stock
UNION ALL SELECT 'outbox_events', count(*) FROM outbox_events
UNION ALL SELECT 'audit_log', count(*) FROM audit_log;

-- 5. Integridad referencial: 0 huérfanos
SELECT count(*) AS ordenes_huerfanas
FROM ordenes o LEFT JOIN productos p ON p.id = o.producto_id
WHERE p.id IS NULL;

SELECT count(*) AS stock_huerfano
FROM movimientos_stock m LEFT JOIN productos p ON p.id = m.producto_id
WHERE p.id IS NULL;

-- 6. Invariantes de negocio: 0 violaciones
SELECT count(*) AS productos_invalidos
FROM productos WHERE precio < 0 OR stock < 0;

-- 7. Índices críticos presentes (trigram, outbox pending, auditoría)
SELECT count(*) AS indices_criticos
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname IN (
    'idx_productos_nombre_trgm',
    'idx_outbox_pending',
    'idx_idempotency_created_at',
    'idx_audit_log_occurred_at'
  );
-- Esperado: 4

-- 8. Outbox no perdió eventos pendientes (si aplica)
SELECT count(*) AS outbox_pendiente FROM outbox_events WHERE published_at IS NULL;
```

Si el restore es para recuperación selectiva, agregá una comparación de la fila dañada antes/después y un `CHECK` de que el `restore-time` es anterior al evento.

## 6. Promoción

La promoción **no** es automática. Requiere ventana, aprobación y un plan de rollback.

### 6.1 Recuperación selectiva (preferida para corrupción lógica)

1. Extraer solo lo necesario del scratch:
   ```bash
   # Construir la URL del scratch con el endpoint restaurado y las mismas credenciales.
   export SCRATCH_URL="postgresql://<user>:<pass>@<scratch-endpoint>:5432/erpdb"
   pg_dump "$SCRATCH_URL" -t productos --data-only --column-inserts > /tmp/productos.sql
   ```
2. Revisar el archivo, contar filas y aplicarlo en la original dentro de una transacción:
   ```sql
   BEGIN;
   -- cargar /tmp/productos.sql con \i
   SELECT count(*) FROM productos;
   -- verificar y COMMIT o ROLLBACK
   ```
3. Nunca ejecutar un `TRUNCATE`/`DROP` en la original sin backup verificado.

### 6.2 Promoción completa (la instancia scratch pasa a ser la primaria)

1. Congelar escrituras (modo mantenimiento, `ENABLE_AUTH`/feature flag o pausar el servicio).
2. Confirmar que el scratch tiene el mismo `db_name`, usuario y password que la original; si no, actualizar el secreto.
3. Actualizar `/erp-pipeline/<env>/db-url` con el endpoint del scratch:
   ```bash
   # Construir la URL con el endpoint nuevo y las mismas credenciales.
   aws ssm put-parameter --name /erp-pipeline/<env>/db-url --type SecureString \
     --value "postgresql://<user>:<pass>@<scratch-endpoint>:5432/erpdb" --overwrite
   ```
4. Forzar un nuevo deployment de ECS para que las tasks lean el parámetro:
   ```bash
   aws ecs update-service --cluster erp-pipeline-<env>-cluster \
     --service erp-pipeline-<env>-service --force-new-deployment
   aws ecs wait services-stable --cluster erp-pipeline-<env>-cluster \
     --services erp-pipeline-<env>-service
   ```
5. Validar `/health/details`, errores 5xx y latencia durante 30 min.
6. Mantener la instancia original detenida o intacta por 24–48h. **No borrarla** hasta cerrar el incidente y confirmar el nuevo backup.
7. Revertir la promoción = volver a poner el endpoint anterior en SSM y forzar deployment. Tenerlo escrito antes de empezar.

## 7. Limpieza

```bash
# Limpieza segura de scratch (solo lo creado por el drill)
bash scripts/restore-drill.sh --environment <env> --cleanup

# Manual, si el state file se perdió: verificar tags ANTES de borrar
aws rds list-tags-for-resource --resource-name <scratch-arn>
aws rds delete-db-instance --db-instance-identifier <scratch> \
  --skip-final-snapshot --delete-automated-backups
```

Nunca borrar la instancia original como parte de la limpieza. Si el drill se ejecutó en prod, la scratch cuesta dinero hasta que se elimine; agendarlo en el mismo ticket.

## 8. Evidencia

Completar una fila por drill. El script imprime una fila lista para pegar.

| Fecha (UTC) | Entorno | Escenario | Restore point | RPO medido | Inicio | Fin | RTO medido | Validación | Responsable | Ticket |
| ----------- | ------- | --------- | ------------- | ---------- | ------ | --- | ---------- | ---------- | ----------- | ------ |
|             |         |           |               |            |        |     |            |            |             |        |

Criterios de aceptación del drill:

- RTO medido ≤ objetivo del entorno.
- RPO medido ≤ objetivo (PITR: `now - LatestRestorableTime`; snapshot: edad del snapshot).
- Las 8 validaciones SQL pasan y los conteos son coherentes con la línea base.
- La instancia scratch se elimina (o queda con ticket y fecha de limpieza).
- La instancia original nunca se modificó (verificar `DescribeDBInstances` antes/después).

## 9. Contactos y escalado

- Incidente de datos → SEV1, ver `docs/runbooks/alert.md#1-severidades`.
- Aprobación de promoción en prod → owner del entorno (`Owner` tag) + on-call.
- Si el restore falla repetidamente, no improvisar sobre la original: escalar a AWS Support con el `DBSnapshotIdentifier`/`RestoreTime` y los eventos de RDS.
