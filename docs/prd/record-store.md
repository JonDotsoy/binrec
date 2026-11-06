# PRD: Servicio `record-store` para grabaciones de binrec

- Estado: borrador para revisión
- Fecha: 2026-11-06
- Autor: Jona (con Claude)
- Contexto: binrec v0.0.11 (`develop`). La conversión a monorepo está en el PR #29 (`packages/binrec`, `apps/landing`); este PRD asume ese layout y propone `apps/store` (servicio) y `packages/store-core` (backends y tipos compartidos), ajustables si el PR cambia.

## 1. Resumen

binrec graba cada ejecución como un archivo `<sessionId>.ndjson` (más `<sessionId>.stats.json`) en `$BINREC_HOME/records/`. Hoy un record solo vive en la máquina que lo grabó. Este PRD define un **servicio `store`** que guarda, lista y entrega records, con almacenamiento intercambiable: **disco local, Google Cloud Storage (GCS) y Amazon S3** (y compatibles con S3 como R2 o MinIO). El CLI podrá subir y bajar records sin conocer el backend.

## 2. Problema

- Los records son el producto de binrec (compartir, revisar, reproducir sesiones), pero compartirlos hoy es copiar archivos a mano.
- No hay lugar común para equipos o CI: un job que graba con binrec pierde el record cuando termina el runner.
- La auditoría de seguridad (`audits/binrec-seguridad.md`) ya señala que los records contienen secretos en texto plano (A1) y que no hay límite de tamaño ni retención (M6). Un servicio que centraliza records amplifica ambos riesgos y debe resolverlos desde el diseño.
- La auditoría de mejoras pide un campo de versión del formato y más contexto en la línea `command`; subir records a un servicio hace urgente fijar el contrato.

## 3. Objetivos

1. Subir, listar, descargar y borrar records vía una API HTTP pequeña y estable.
2. Abstracción de backend con tres implementaciones de primera: `local`, `gcs`, `s3`. Cambiar de backend es solo configuración.
3. Integración con el CLI: `binrec push`, `binrec pull`, `binrec remote` y subida automática opcional al terminar `rec`.
4. Metadatos consultables sin descargar el record completo (comando, fecha, código de salida, tamaño, etiquetas).
5. Seguro por defecto: autenticación obligatoria, redacción de secretos antes de subir, cifrado en tránsito y en reposo, retención configurable.
6. Operable con una sola imagen/proceso (Bun), sin base de datos obligatoria.

## 4. No objetivos

- No es un servicio de reproducción: el player (`play --ui`) sigue siendo local; el store solo entrega bytes. Un visor web alojado queda para una fase posterior.
- No hay streaming en vivo de grabaciones en esta versión.
- No reemplaza al directorio local: grabar sigue siendo local-primero y funciona sin red.
- No hay multi-tenant con facturación, SSO empresarial ni búsqueda de texto completo dentro del contenido.
- No se edita un record subido: es inmutable.

## 5. Usuarios y casos de uso

| Usuario | Caso |
| --- | --- |
| Desarrollador individual | Sube una sesión y comparte un enlace con un colega o lo adjunta a un issue. |
| Equipo | Servicio compartido con bucket propio; todos suben y consultan records del proyecto. |
| CI | Un job graba tests con binrec y sube los records como evidencia; se descargan al fallar. |
| Operador | Despliega el servicio, elige backend, define retención y rota credenciales. |

## 6. Formato de récord

El servicio guarda el ndjson **tal cual lo escribe binrec**, sin reinterpretarlo, más un documento de metadatos.

**Objeto almacenado.** Clave `records/<sessionId>.ndjson` (opcionalmente comprimido, ver 8.3). `sessionId` es un UUID v4 generado por el cliente; el servicio lo valida.

**Metadatos** (`records/<sessionId>.meta.json`, calculados por el servicio al recibir el record, nunca confiando en el cliente):

```json
{
  "sessionId": "uuid",
  "command": "/usr/bin/git",
  "args": ["status"],
  "parent": null,
  "depth": 0,
  "startedAt": "2026-11-06T02:50:00.000Z",
  "exitCode": 0,
  "total": 1234,
  "size": 5678,
  "sha256": "hex",
  "format": 1,
  "uploadedAt": "2026-11-06T02:51:00.000Z",
  "uploadedBy": "token-id",
  "labels": { "ci": "github", "repo": "JonDotsoy/binrec" },
  "redacted": true
}
```

Los campos salen de las líneas `command` y `end` y del `.stats.json` existente. **Dependencia:** hoy el ndjson no lleva versión de formato; el PRD pide añadir `format: 1` (y `binrecVersion`, `cwd`) a la línea `command` como en la auditoría de mejoras (sección 2). Mientras no exista, el servicio asume formato 1 para records sin el campo. Una última línea truncada (hallazgo 1.3) se acepta y se marca `truncated: true`.

**Tamaño.** Máximo configurable por record (por defecto 256 MiB) y por token (cuota total).

## 7. Requisitos funcionales

### 7.1 API HTTP (v1)

Prefijo `/v1`. JSON salvo en subida y descarga de records. Errores con `{ "error": { "code", "message" } }`.

| Método y ruta | Descripción |
| --- | --- |
| `PUT /v1/records/:sessionId` | Sube el ndjson (cuerpo en streaming, `Content-Type: application/x-ndjson`). Cabeceras opcionales: `Content-Encoding: gzip`, `X-Binrec-Label-<k>: v`. Idempotente: repetir con el mismo contenido (mismo `sha256`) responde 200; contenido distinto sobre el mismo id responde 409. Devuelve los metadatos. |
| `GET /v1/records` | Lista metadatos. Filtros: `command`, `exitCode`, `since`, `until`, `label.<k>=<v>`, `limit`, `cursor`. Orden por `startedAt` descendente, paginación por cursor. |
| `GET /v1/records/:sessionId` | Metadatos de un record. |
| `GET /v1/records/:sessionId/content` | Descarga el ndjson en streaming. Soporta `Range` y `Accept-Encoding: gzip`. |
| `DELETE /v1/records/:sessionId` | Borra record y metadatos. Requiere el permiso `delete`. |
| `GET /v1/health` | Estado del servicio y del backend (sin autenticación, sin datos sensibles). |
| `GET /v1/records/:sessionId/url` | Opcional: URL firmada de corta duración (GCS/S3) para descarga directa. Con backend local devuelve la ruta de `content`. |

**Subida directa a bucket (fase 2).** Para records grandes, `POST /v1/records/:sessionId/upload-url` devuelve una URL firmada de subida; el cliente sube directo al bucket y confirma con `POST .../complete`, momento en que el servicio valida tamaño y hash y escribe los metadatos.

### 7.2 Autenticación y autorización

- Tokens de portador (`Authorization: Bearer <token>`), generados con `binrec-store token create`. Se guarda solo el hash del token.
- Permisos por token: `read`, `write`, `delete`, `admin`. Alcance opcional por prefijo de etiqueta (ej. solo `repo=JonDotsoy/binrec`).
- Cuotas por token (bytes totales, records por día).
- Fase posterior: OIDC (por ejemplo tokens de GitHub Actions) para que CI suba sin secretos de larga vida.
- Sin autenticación solo en `127.0.0.1` con `--insecure-local`, explícito en el arranque.

### 7.3 Abstracción de backend

Interfaz mínima en `packages/store-core`:

```ts
interface RecordBackend {
  put(key: string, body: ReadableStream<Uint8Array>, opts: PutOptions): Promise<ObjectInfo>;
  get(key: string, opts?: { range?: ByteRange }): Promise<{ body: ReadableStream<Uint8Array>; info: ObjectInfo } | null>;
  head(key: string): Promise<ObjectInfo | null>;
  delete(key: string): Promise<void>;
  list(prefix: string, opts: { cursor?: string; limit: number }): Promise<{ items: ObjectInfo[]; next?: string }>;
  signedUrl?(key: string, op: "get" | "put", ttlSeconds: number): Promise<string>;
}
```

| Backend | Implementación | Notas |
| --- | --- | --- |
| `local` | Directorio (`BINREC_STORE_DIR`), permisos 0700/0600, escritura atómica (temporal + rename), protección contra path traversal y symlinks (hallazgo B1). | Por defecto; también para desarrollo y tests. |
| `gcs` | Google Cloud Storage. Autenticación con Application Default Credentials o cuenta de servicio, preferible Workload Identity. Escritura condicional con `ifGenerationMatch: 0` para impedir sobrescrituras. Cifrado por defecto o CMEK (`kmsKeyName`). | URLs firmadas V4. |
| `s3` | Amazon S3 y compatibles (endpoint configurable: R2, MinIO). Credenciales por cadena estándar de AWS (rol de IAM, variables de entorno). Escritura condicional con `If-None-Match: *`. SSE-S3 o SSE-KMS. | Subida multiparte para records grandes. `forcePathStyle` opcional. |

Decisión de implementación a validar: usar SDK oficial (`@google-cloud/storage`, `@aws-sdk/client-s3`) o los clientes nativos de Bun (`Bun.S3Client` ya cubre S3 y compatibles; GCS tiene API compatible con S3 vía HMAC, pero preferimos la API nativa de GCS para ADC y Workload Identity). Los SDK van como dependencias **opcionales cargadas bajo demanda**, para que `binrec` no engorde por quien no usa el store.

**Índice de metadatos.** Fase 1: los `.meta.json` junto a cada objeto, listados por prefijo (sin base de datos; el filtrado se hace en memoria sobre la página). Si el volumen lo exige, fase 3 añade un índice SQLite (`bun:sqlite`) reconstruible desde el bucket, que nunca es fuente de verdad.

**Configuración.** Archivo `store.config.json` o variables de entorno:

```json
{
  "backend": { "type": "gcs", "bucket": "mi-bucket", "prefix": "binrec/" },
  "maxRecordBytes": 268435456,
  "retentionDays": 90,
  "redact": { "mode": "server", "rules": ["Authorization: *", "--password=*"] }
}
```

### 7.4 Integración con el CLI

- `binrec remote add <name> <url> [--token-env VAR]`: guarda en `config.json` (el token nunca en claro; se lee de la variable indicada).
- `binrec push [<id|prefix>|--all] [--remote name] [--label k=v]`: sube records locales; omite los que ya existen por `sha256`.
- `binrec pull <id> [--remote name]` y `binrec list --remote name`.
- `rec --push` o `"autoPush": true` en `config.json`: sube al terminar, en segundo plano y sin afectar el código de salida del programa grabado. Si falla, deja el record local y reintenta en el siguiente `push`.
- El servicio también se usa como librería: `new StoreClient({ url, token })` en `packages/binrec`.

### 7.5 Ciclo de vida

- Retención por días y por cantidad, aplicada por un barrido periódico (`binrec-store gc`) o por reglas nativas del bucket (lifecycle de GCS/S3), documentando ambas.
- Borrado seguro de un record y sus metadatos en una sola operación lógica; si falla a la mitad, el barrido repara.

## 8. Seguridad

1. **Secretos en records (auditoría A1).** Subir un record es compartirlo. Requisitos: redacción en el cliente antes de subir (`push` aplica las reglas de `redact` de `config.json`), redacción adicional del servidor por reglas, enmascarado de stdin con eco apagado cuando binrec lo implemente, y aviso explícito en `push` si el record no fue redactado. `--no-redact` exige confirmación y queda registrado en los metadatos (`redacted: false`).
2. **Transporte.** Solo HTTPS fuera de `127.0.0.1`; el servicio puede ir tras un proxy o terminar TLS él mismo.
3. **Cifrado en reposo.** Cifrado del proveedor siempre activo; CMEK / SSE-KMS configurable. Cifrado del lado del cliente queda como pregunta abierta.
4. **Credenciales de bucket.** Mínimo privilegio: el servicio solo necesita `put/get/delete/list` sobre su prefijo. Preferir identidad de carga de trabajo / roles de IAM antes que claves estáticas. Nunca se registran credenciales ni tokens en logs.
5. **Validación de entrada.** `sessionId` UUID estricto; claves derivadas solo de ahí (sin rutas del cliente); límite de tamaño y de longitud de línea; se verifica que cada línea sea JSON válido y de un `type` conocido antes de aceptar (el contenido jamás se interpreta ni ejecuta).
6. **Inmutabilidad y auditoría.** Sin sobrescritura (escritura condicional por backend); registro de auditoría estructurado de subidas, descargas y borrados con id de token.
7. **Abuso.** Límite de tasa y cuotas por token; bucket sin acceso público; URLs firmadas de vida corta (por defecto 5 minutos).
8. **Cabeceras y CORS.** CORS cerrado por defecto; `Content-Disposition: attachment` y `nosniff` en descargas.
9. **Cadena de suministro.** Dependencias de SDK fijadas y Actions fijadas por SHA (hallazgo M2 de la auditoría).
10. `SECURITY.md` se amplía con el modelo de amenazas del store.

## 9. Requisitos no funcionales

- Rendimiento: subida y descarga en streaming, memoria acotada independiente del tamaño del record (a diferencia de `readSession`, hallazgo B5). Listado de 10 000 records en menos de 1 s con índice; sin índice se documenta el límite.
- Disponibilidad: sin estado local salvo caché; escalable horizontalmente porque el bucket es la fuente de verdad.
- Observabilidad: logs JSON, métricas básicas (`/v1/metrics` opcional), `health` que prueba el backend.
- Pruebas: batería de contrato común que se ejecuta contra los tres backends (local siempre; GCS y S3 con emuladores `fake-gcs-server` y MinIO en CI), más tests de la API con `bun test`.
- Despliegue: imagen OCI y `bun build --compile`; ejemplos para Cloud Run (GCS) y ECS/Fargate o una VM (S3).
- Compatibilidad: sigue la convención del repo (Bun primero, `Bun.serve()`, `bun:sqlite`; sin Express).

## 10. Métricas de éxito

- Un record se sube y se descarga idéntico (hash) en los tres backends con la misma suite de contrato.
- `binrec push` + `binrec pull` en menos de 5 comandos de configuración desde cero.
- Cero secretos conocidos (reglas de prueba) en objetos subidos con redacción activa.
- Uso real: el CI del propio repo sube sus records de tests.

## 11. Fases

| Fase | Alcance | Criterio de salida |
| --- | --- | --- |
| 0. Diseño | Aprobar este PRD; fijar `format: 1` en la línea `command`; resolver preguntas abiertas. | PRD aprobado. |
| 1. MVP | `store-core` con interfaz y backend `local`; API `PUT/GET/LIST/DELETE`; tokens con `read/write`; `binrec remote/push/pull/list --remote`. | Flujo extremo a extremo local con tests. |
| 2. Nube | Backends `gcs` y `s3`; suite de contrato; URLs firmadas; subida directa; escritura condicional; imagen OCI y guías de despliegue. | Contrato verde en los tres backends. |
| 3. Seguridad y operación | Redacción cliente/servidor, cuotas, retención y `gc`, auditoría, OIDC para CI, `rec --push` automático. | Revisión de seguridad sin hallazgos altos. |
| 4. Escala y UX | Índice SQLite opcional, visor web de records alojados, compartir por enlace con caducidad. | Según demanda. |

## 12. Riesgos

| Riesgo | Mitigación |
| --- | --- |
| Filtración de secretos al subir | Redacción por defecto, aviso, `redacted` en metadatos, enmascarado de stdin (A1). |
| Dependencias pesadas en un paquete pensado liviano | Store en su propio paquete; SDK opcionales y cargados bajo demanda. |
| Diferencias sutiles entre GCS y S3 (consistencia, condicionales, multiparte) | Interfaz mínima y suite de contrato obligatoria. |
| Costos de egreso/almacenamiento sin control | Cuotas, retención, compresión, lifecycle del bucket. |
| Cambios del formato ndjson rompen records antiguos | Campo `format`, servidor tolerante con records sin versión. |
| Choque con la reorganización a monorepo (PR #29) | Rutas definidas aquí son provisionales hasta que se fusione. |

## 13. Preguntas abiertas

1. ¿El store vive en este repo (`apps/store`) o en uno aparte? ¿Se publica como paquete npm, solo como imagen, o ambos?
2. ¿Hospedaje propio del proyecto (un servicio público de binrec) o solo software para que cada equipo lo despliegue? Cambia el modelo de autenticación (cuentas vs. tokens) y el de costos.
3. ¿SDK oficiales de nube o clientes nativos de Bun? ¿Se acepta la dependencia opcional?
4. ¿Cifrado del lado del cliente (el servicio nunca ve texto plano)? Choca con redacción y metadatos en servidor.
5. ¿Compresión obligatoria (gzip/zstd) al almacenar? Afecta `Range` y el hash.
6. ¿Metadatos junto al objeto (simple) o índice SQLite desde la fase 1?
7. ¿Qué etiquetas son estándar (repo, rama, job de CI) y quién las rellena?
8. ¿Se agrega ya `format`/`binrecVersion`/`cwd` a la línea `command`, o el servidor los deduce?
9. ¿Subida automática activada por defecto en CI cuando hay un remoto configurado?
10. ¿Otros backends (Azure Blob) quedan fuera por ahora?
