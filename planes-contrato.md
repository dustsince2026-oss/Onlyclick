# Sistema de planes OnlyClick — CONTRATO DE CONSTRUCCIÓN (24 nov 2026)

Fuente de verdad de negocio: `~/workspace/goals/onlyclick-app-development/files/plan-precios-fotografos-2026-11-23.md`
(lo decidido por Orlan el 24 nov 2026). Este documento es el contrato técnico
que los 3 agentes (backend, frontend, tests) deben cumplir al pie de la letra.
Si este contrato y el documento de negocio discrepan, manda el de negocio
y anótalo en tu entrega.

## 0. Reglas duras del proyecto (no negociables)

- Entrypoint en vivo: `server.js` (raíz). Los wrappers `api/*.js` son código
  muerto en producción. Rutas nuevas: caso en `dispatch()` de
  `api/_lib/handlers.js` + entrada en `ROUTES` de `server.js`.
- Cada cambio en `handlers.js` debe pasar `node --check` Y una carga real
  con `require()` antes de darse por bueno.
- Tests: NO hay package.json. Se corren así (desde la carpeta del proyecto):
  `NODE_PATH=/home/hatch/workspace/onlyclick-miniaturas-galeria/node_modules:/home/hatch/workspace/onlyclick-form-fotografos/node_modules node --test --test-concurrency=1 test/*.test.js`
  con env `AUTH_SECRET='test-secret-onlyclick'`, `CLIP_API_KEY='test-clip-key'`,
  `CLIP_API_SECRET='test-clip-secret'`. SIEMPRE `--test-concurrency=1`
  (los suites comparten `data/db.json`). Los tests usan runners manuales
  con contadores pass/fail, NO node:test. Patrón a seguir:
  `test/pagos-pendientes.test.js` (mockea `clip.js` y `mailer.js` con
  `require.cache`, usa el `fileStore` real, llama a `dispatch`).
- Si tocas `public/app.js`, sube la versión en `public/index.html`
  (hoy `/app.js?v=20261122f` → `/app.js?v=20261124a`).
- NO desplegar nada. El trabajo termina en código + tests en local.
- CORREGIDO 2026-11-24: `CLIP_FEE_RATE` pasó de 0.0418 a **0.0406** (tasa
  real verificada: 3.50% + 16% de IVA sobre la comisión = 4.06%). La
  discrepancia preexistente quedó resuelta; tests y textos actualizados.
- No inventar precios ni reglas nuevas. Lo no especificado aquí se
  decide por lo más simple y se anota.

## 1. Configuración de planes (en `api/_lib/handlers.js`, exportada)

```js
const PLANS = {
  gratis: { id: 'gratis', label: 'Gratis', commissionRate: 0.15, monthlyFee: 0,   uploadCap: 2000 },
  lite:   { id: 'lite',   label: 'Lite',   commissionRate: 0.10, monthlyFee: 299, uploadCap: 4000 },
  pro:    { id: 'pro',    label: 'Pro',    commissionRate: 0.07, monthlyFee: 499, uploadCap: 9000 },
  legado: { id: 'legado', label: 'Legado (10%)', commissionRate: 0.10, monthlyFee: 0, uploadCap: 2000, selectable: false },
};
const MIN_PHOTO_PRICE_MXN = 50;
const PLAN_GRACE_DAYS = 3;          // días de gracia tras vencer un plan pagado
const PLAN_MONTH_DAYS = 30;         // un "mes" de plan = 30 días naturales
```

- `legado` NO es elegible por el fotógrafo (solo lo asigna la migración a
  Sandy id 3 y Ricardo id 95). Es 10% sin mensualidad, tope 2,000, mínimo $50.
- **El dueño (user.isOwner) está FUERA del sistema de planes**: sin tope de
  subida, exento del mínimo de $50, y sus propias fotos se reparten con la
  tasa histórica 0.10 (su dinero es suyo de todos modos; así sus correos de
  venta y sus cifras no cambian).
- Plan desconocido o ausente en la fila del usuario → se trata como `gratis`.
- Exportar desde handlers: `PLANS`, `MIN_PHOTO_PRICE_MXN`, `PLAN_GRACE_DAYS`,
  `effectivePlan`, `splitSale` (ya exportado; añadir parámetro opcional de tasa).

## 2. Resolución del plan efectivo (función pura, sin escribir en BD)

```js
function effectivePlan(user, nowMs)
```

- Entrada: fila de usuario (con `plan`, `planExpiresAt`, `isOwner`).
- Dueño → `{ plan: 'gratis', rate: 0.10, cap: Infinity, monthlyFee: 0, status: 'owner', ... }`
  (el dueño no tiene tope ni plan; la tasa 0.10 solo es para sus propias ventas).
- `legado` / `gratis` → plan tal cual, `status: 'active'`, sin vencimiento.
- `lite` / `pro` con `planExpiresAt`:
  - `now < expiresAt` → `status: 'active'`.
  - `expiresAt <= now < expiresAt + 3 días` → `status: 'grace'`, conserva
    comisión y tope del plan pagado.
  - `now >= expiresAt + 3 días` → efectivo `gratis` (`status: 'expired'`).
- Devuelve SIEMPRE: `{ plan, label, commissionRate, monthlyFee, uploadCap,
  status, expiresAt, graceUntil }`.
- La aplicación de la baja es PEREZOSA: solo el endpoint `plan-status`
  persiste la baja a Gratis (updateUser) cuando el plan pagado ya pasó la
  gracia. Todo lo demás (subida, comisiones) usa `effectivePlan` sin escribir.

## 3. Modelo de datos

### 3.1 Columnas nuevas en `users`
- `plan` text NOT NULL DEFAULT 'gratis'
- `plan_expires_at` timestamptz (NULL = sin vencimiento)
- Mapear en `mapUser` (Supabase) y en el whitelist de `updateUser`
  (Supabase): `plan` → `plan`, `planExpiresAt` → `plan_expires_at`.
  El fileStore guarda camelCase tal cual (Object.assign ya lo hace).

### 3.2 Tasa guardada en cada venta
- `downloads.commission_rate` numeric (NULL en ventas viejas).
- `payments.commission_rate` numeric (NULL en ventas viejas).
- Se escribe al CONFIRMARSE el pago (en `markPaymentPaid`): tasa efectiva
  del dueño de la foto en ese momento (dueño de la foto → 0.10).
- `mapDownload` y `mapPayment` (Supabase) la exponen como `commissionRate`.
- `addDownload` (Supabase) la acepta con el patrón tolerante existente:
  si falta la columna (SQL sin correr), reintenta sin ella (como ya se
  hace con `base_amount` / `commission_free`).
- `updatePaymentStatus` acepta `commissionRate` en el patch (ambos stores).

### 3.3 Tabla nueva `plan_payments`
- `id` bigint identity PK, `photographer_id` bigint NOT NULL,
  `plan` text NOT NULL ('lite' | 'pro'), `amount_mxn` numeric NOT NULL,
  `clip_payment_request_id` text, `payment_url` text,
  `status` text NOT NULL DEFAULT 'pending'
  ('pending' | 'completed' | 'cancelled' | 'expired'),
  `created_at` timestamptz NOT NULL DEFAULT now(),
  `paid_at` timestamptz.
- `ALTER TABLE plan_payments ENABLE ROW LEVEL SECURITY` + GRANTs a
  service_role (tablas + secuencia), como en `sql/face_index.sql`.
- El SQL de migración va en `migration-planes-2026-11-24.sql` (raíz de la
  carpeta del proyecto). Incluir: ALTERs de users/downloads/payments,
  CREATE TABLE plan_payments, índice `photos (photographer_id, created_at)`
  para el conteo mensual, backfill `UPDATE users SET plan='legado'
  WHERE id IN (3, 95) AND role='photographer'`, y consultas de verificación.
  Todo con IF NOT EXISTS / tolerante (se puede correr dos veces).
  NO ejecutar el SQL contra Supabase: lo aplica el coordinador principal.

### 3.4 Conteo mensual de subidas (método nuevo en AMBOS stores)
```js
countPhotosByPhotographerInMonth(photographerId, year, month) // month 1-12, mes calendario UTC
```
- fileStore: filtra `photos` por `photographerId` y `createdAt` con prefijo `YYYY-MM`.
- supabaseStore: count exact con `gte(created_at, YYYY-MM-01)` y `lt(created_at, YYYY-MM+1-01)`.
- Si el store no tiene el método (store viejo), el handler usa
  `tryStore` y cae a 0 (sin bloquear la subida) — mismo patrón que
  `listAllParticipants`.

## 4. Comisiones por plan

- `splitSale(amount, rate)` — `rate` opcional, default `ORLAN_FEE_RATE`
  (0.10) para que TODO lo existente siga igual.
- `splitRewardSale(paidAmount, baseAmount, rate)` — mismo parámetro opcional;
  el fotógrafo cobra `splitSale(base, rate).photographerShare`.
- `splitDownload(d)` — usa `d.commissionRate` si viene (número), si no 0.10.
  Pasa la tasa a `splitRewardSale` también.
- `markPaymentPaid`: antes de `addDownload`, resuelve la tasa efectiva del
  dueño de la foto (`photoOwnerId` → `findUserById` → `effectivePlan`) y la
  guarda en la descarga y en el pago (`updatePaymentStatus` con
  `commissionRate`). Las descargas gratis ($0) no llevan tasa (NULL).
- `notifySale`: el texto ya no dice "el 10% de OnlyClick" fijo; usa la tasa
  guardada de la venta (`${Math.round(rate*100)}% de OnlyClick`). Si no hay
  tasa guardada, 10%.
- `notifyPayout`: quitar el "(10%)" fijo → "Comisión OnlyClick: $X MXN"
  (el total ya viene en la fila de payout; no inventar un %).
- `photographerEarnings`, `listSales`, `payoutsSummary`, `myEarnings` NO se
  reescriben: ya usan `splitDownload`, así que heredan la tasa guardada.

## 5. Topes de subida

- En `uploadPhoto`, DESPUÉS de las validaciones de evento/participante y
  ANTES de `createPhoto`: si NO es dueño, `used =
  countPhotosByPhotographerInMonth(...)`, `cap = effectivePlan(user).uploadCap`;
  si `used >= cap` → `err(403, 'Llegaste a tu tope de X fotos este mes
  (plan Y). Sube de plan para seguir subiendo o espera al próximo mes.')`.
- Borrar fotos o álbumes NO baja el conteo (el conteo es por `created_at`
  del mes, no por fotos vivas). No hay que tocar `deletePhoto`/`deleteEvent`.
- El tope restante se muestra en `plan-status` (`uploadsUsed`, `uploadsLeft`).

## 6. Precio mínimo $50

- Helper `enforceMinPrice(user, price)`: dueño → pasa; `price < 50` →
  `err(400, 'El precio mínimo por foto es $50 MXN.')`.
- Aplicar en: `createEvent` (solo evento de pago, no exclusivo ni freeMode;
  si no viene precio y no es dueño, el default pasa de $20 a $50), `joinEvent`,
  `setEventPrice`, `setMyEventPrice` (después del `validPrice` actual).
- Los precios YA guardados por debajo de $50 NO se reescriben (CANACINTRA
  $40 del dueño queda como está; es dueño y está exento de todos modos).
- Los eventos `freeMode` y exclusivos no se afectan (precio irrelevante).

## 7. Endpoints nuevos (dispatch + ROUTES en server.js)

Nombres de ruta (URL `/api/<ruta>` → caso dispatch):
- `GET /api/plan-status` → caso `plan-status`. Fotógrafo (su propio estado;
  el dueño también puede consultarlo). Devuelve:
  `{ plan, label, commissionRate, monthlyFee, uploadCap,
     uploadsUsed, uploadsLeft, expiresAt, graceUntil, status,
     pendingPayment: { id, plan, amountMxn, paymentUrl, status, createdAt } | null,
     plans: [{ id, label, commissionRate, monthlyFee, uploadCap }] }`
  (la lista `plans` NO incluye `legado`). Si el plan pagado pasó la gracia,
  persiste la baja a Gratis ANTES de responder. `pendingPayment` /
  `pendingPayments` traen SOLO pendientes vivos: los cancelados y los
  vencidos (más de 3 días sin pagar, `PLAN_PENDING_EXPIRY_DAYS = 3`) no
  salen; el vencimiento se persiste perezoso al leer (status='expired').
- `POST /api/plan-select { plan }` → caso `plan-select`. Fotógrafo.
  `plan` ∈ {gratis, lite, pro}. `gratis` → baja inmediata (plan='gratis',
  planExpiresAt=null). `lite`/`pro` → crea fila `plan_payments` pendiente
  (si ya hay una pendiente para ese plan, la devuelve sin duplicar) y la
  devuelve. NO activa el plan. Si ya está en ese plan pagado y activo →
  devuelve el estado actual sin crear nada.
  SOLO QUEDA PENDIENTE EL ÚLTIMO (Orlan, 2026-11-25): cuando el pendiente
  se crea (o se devuelve) CON link de Clip, los demás pendientes del
  fotógrafo se cancelan (status='cancelled'). Si Clip falla (502), el
  viejo se conserva y el reintento lo reutiliza. Los pendientes de más
  de 3 días se vencen solos al leerlos (ver plan-status) y no se reutilizan.
- `POST /api/plan-payment-create { planPaymentId }` → caso
  `plan-payment-create`. SOLO dueño. Crea el link de Clip con
  `createClipLink` (reutilizarlo, NO `clip.createCheckoutLink` directo):
  amount = 299 o 499 según la fila, `purchase_description` =
  `Plan Lite OnlyClick (1 mes)` / `Plan Pro OnlyClick (1 mes)`,
  `metadata.external_reference` = `OC-PLAN-<id>-<azar>` (máx 36 chars),
  `redirection_url` success → `publicBase() + '/?plan=pagado'`,
  error/default → `publicBase() + '/?plan=error'`.
  Guarda `clip_payment_request_id` y `paymentUrl` en la fila (hace falta un
  método de store para guardar la URL: añadir `paymentUrl` al patch de
  `updatePlanPayment`; columna `payment_url` text en la migración).
  Devuelve `{ planPayment, paymentUrl }`. Si la fila ya tiene link, lo
  devuelve sin crear otro.
- `POST /api/plan-payment-status { planPaymentId }` → caso
  `plan-payment-status`. Fotógrafo dueño de la fila (o dueño de la página).
  Re-consulta Clip (`clip.getCheckout`) y si está COMPLETED activa el plan
  (ver §8). Devuelve `{ status, plan, expiresAt }`. Una fila cancelada o
  vencida NO se activa por este camino (devuelve su estado sin consultar
  Clip); si el dinero llegó tarde, el dueño la activa con mark-paid.
- `POST /api/plan-payment-mark-paid { planPaymentId }` → caso
  `plan-payment-mark-paid`. SOLO dueño. Marca la fila completed + paidAt y
  activa el plan (ver §8). Es el equivalente manual de "Marcar como pagado"
  de payouts (para transferencias/efectivo). Es el ÚNICO camino que puede
  activar una fila vencida o cancelada (si el dinero llegó tarde a Clip).
- `GET /api/plan-payments` → caso `plan-payments`. SOLO dueño. Devuelve
  `{ planPayments: [{ id, photographerId, photographerName, plan,
  amountMxn, status, paymentUrl, createdAt, paidAt }] }` (últimos primero).
  Solo se muestran pendientes vivos y pagados: los cancelados y vencidos
  (más de 3 días, vencidos perezosamente al leer) no salen en el panel.
- Extender `list-photographers`: cada fila suma `{ plan, planLabel,
  commissionRate, planExpiresAt, planStatus }` (status con `effectivePlan`,
  sin consultas extra).
- Webhook `clip-webhook`: si `getPaymentsByClipId(id)` viene vacío, buscar
  plan payment por clip id (`getPlanPaymentByClipId`); si existe y no está
  completado, re-consultar Clip y si COMPLETED activar el plan (ver §8).
  No tocar el flujo de fotos. El secreto en la URL se valida igual que antes.
  Una fila cancelada o vencida NO se activa por webhook (se ignora); si el
  dinero llegó tarde, el dueño la activa con mark-paid.

## 8. Activación de plan (helper en handlers.js)

```js
async function activatePlan(store, photographerId, plan) // plan 'lite'|'pro'
```
- `updateUser(photographerId, { plan, planExpiresAt: new Date(Date.now() + 30*24*3600*1000).toISOString() })`.
- Se usa desde: webhook (plan payment), `plan-payment-status` (al confirmar),
  `plan-payment-mark-paid`. La fila `plan_payments` se marca completed +
  paidAt en el mismo flujo (antes o después, pero las dos cosas o ninguna
  se deja a medias: si falla el updateUser, no marcar completed).
- Renovar en gracia: el mes nuevo corre desde la fecha de pago (no desde
  el vencimiento viejo).

## 9. Store: métodos nuevos (AMBOS adaptadores)

- `countPhotosByPhotographerInMonth(photographerId, year, month)` (§3.4).
- `createPlanPayment(p)` → `{ id, photographerId, plan, amountMxn, clipPaymentRequestId, paymentUrl, status, createdAt, paidAt }`.
- `getPlanPaymentById(id)`, `getPlanPaymentByClipId(clipId)`,
  `listPlanPaymentsByPhotographer(photographerId)`,
  `listPlanPayments()` (todas, recientes primero),
  `updatePlanPayment(id, patch)` — patch admite `status`, `clipPaymentRequestId`,
  `paymentUrl`, `paidAt`.
- Mappers Supabase: `mapPlanPayment` (snake→camel). Lecturas tolerantes:
  si la tabla no existe, devolver `[]`/`null` (patrón de `listParticipants`).
- `updateUser` (Supabase): añadir `plan` y `planExpiresAt` al whitelist.
- `mapUser` (Supabase): añadir `plan: r.plan || 'gratis'`,
  `planExpiresAt: r.plan_expires_at || null`.
- `addDownload` / `updatePaymentStatus`: aceptar `commissionRate` (§3.2).
- `updatePaymentStatus` (fileStore) ya hace patch genérico; añadir el
  campo al Supabase igual que `commissionFree`.

## 10. Frontend (`public/app.js` + `public/index.html`)

- Nueva pestaña "Mi plan" en el panel del fotógrafo (junto a Gestión,
  Ventas, Mis ganancias, Estadísticas). El dueño ve "Eres el dueño:
  sin límites de plan" en vez de las tarjetas.
- La pestaña muestra (desde `GET /api/plan-status`): plan actual, fotos
  subidas este mes / tope (con barra o texto "X de 2,000"), vencimiento o
  gracia, tarjetas Gratis/Lite/Pro con comisión, mensualidad y tope, botón
  "Elegir" por tarjeta (llama `plan-select`); si hay pago pendiente: link
  de Clip + botón "Verificar pago" (`plan-payment-status`).
- Subida al tope: cuando `upload-photo` devuelve el error 403 de tope,
  mostrar el mensaje + botón "Ver mi plan" (ir a la pestaña Mi plan).
- Precios: todos los inputs de precio de fotógrafo (crear evento si pide
  precio, unirse `#joinPrice`, `set-event-price`, `set-my-event-price`)
  llevan `min=50` + texto "Mínimo $50 por foto" cuando NO es dueño.
  El dueño no ve el mínimo.
- Panel del dueño, pestaña Fotógrafos: cada fila muestra plan + vencimiento.
  Debajo de la tabla, bloque "Pagos de planes" (desde `GET /api/plan-payments`):
  por fila pendiente, botones "Generar link de pago" (`plan-payment-create`)
  y "Marcar pagado" (`plan-payment-mark-paid`); si ya tiene link, mostrarlo.
- Banner `?plan=pagado`: al abrir con ese parámetro, mostrar aviso
  "Pago recibido, tu plan se activó" (y limpiar el parámetro de la URL);
  `?plan=error` → "El pago no se completó, inténtalo de nuevo".
- Bump: `public/index.html` → `/app.js?v=20261124a`.
- No romper nada existente: los textos y flujos viejos quedan igual.
- No usar `onclick="..."` inline en HTML generado: enlazar con `.onclick`
  en JS (lección jsdom: los inline no se ejecutan con runScripts outside-only).

## 11. Tests (`test/planes.test.js`, patrón de `test/pagos-pendientes.test.js`)

- Mockear `clip.js` (createCheckoutLink → link de prueba; getCheckout →
  CHECKOUT_COMPLETED) y `mailer.js` (no-ops) con `require.cache`.
- Usar el `fileStore` real + `dispatch`. Contadores pass/fail manuales.
- Cubrir como mínimo:
  1. Config: tasas y topes de los 3 planes + legado; dueño exento.
  2. Mínimo $50: createEvent/join/setEventPrice/setMyEventPrice rechazan
     $20/$49 a un fotógrafo normal; aceptan $50; el dueño puede poner $20;
     freeMode no se afecta.
  3. Tope: fotógrafo Gratis con 2,000 fotos creadas en el mes → el upload
     2,001 devuelve 403 con mensaje de tope; dueño sin tope; mes nuevo
     (createdAt de otro mes) no cuenta.
  4. Comisión guardada: venta confirmada (checkout con clip mockeado) de
     foto de fotógrafo Gratis guarda `commissionRate` 0.15 en descarga y
     pago; `photographerEarnings` reparte con 15%; venta vieja sin tasa
     usa 0.10.
  5. Gracia y baja perezosa: plan Lite vencido hace 1 día → sigue Lite
     (gracia); vencido hace 4 días → `plan-status` lo baja a Gratis y lo
     persiste.
  6. Pago de plan: `plan-select` lite crea pendiente; `plan-payment-create`
     (dueño) genera link (clip mock); webhook con ese clip id activa Lite
     por 30 días; `plan-payment-mark-paid` activa sin Clip.
  7. `list-photographers` incluye plan/vencimiento/estado.
  8. Frontend (jsdom, app.js real): la pestaña "Mi plan" existe y muestra
     el tope; el input de unirse lleva min=50 para no-dueño.
  9. Link fallido y dos pendientes: plan-select sin link → 502 (nunca
     éxito); el reintento genera el link en la misma fila; el frontend
     dibuja un botón de pago por pendiente y el aviso de éxito solo sale
     con link de verdad.
  10. Supersede (Orlan, 2026-11-25): plan-select pro con un Lite pendiente
      cancela el Lite; plan-status y plan-payments listan solo el último;
      con Clip caído el viejo se conserva y el reintento lo reutiliza.
  11. Vencimiento a 3 días: pendiente de hace 4 días se marca expired al
      leerlo y ya no sale en plan-status ni plan-payments; pendiente de
      hace 2 días sigue vivo; webhook y plan-payment-status NO activan
      una fila vencida/cancelada; mark-paid del dueño SÍ la activa.
- El archivo de tests NO debe dejar `data/db.json` en un estado que rompa
  los demás suites: seguir el patrón de los tests existentes (ellos
  reescriben/usan su propio estado; revisar cómo lo hacen antes de escribir).

## 12. Reparto de trabajo (cada agente toca SOLO sus archivos)

- BACKEND: `api/_lib/handlers.js`, `api/_lib/store.js`, `server.js`,
  `migration-planes-2026-11-24.sql`. No tocar `public/` ni `test/`.
- FRONTEND: `public/app.js`, `public/index.html`. No tocar `api/` ni `test/`.
- TESTS: `test/planes.test.js` (nuevo). No tocar nada más.
- Al terminar cada uno: `node --check` del archivo tocado + carga con
  `require()` (backend) y corrida de SU suite nueva (tests). El coordinador
  corre la suite completa al integrar.
