# OnlyClick — versión para Vercel (proyecto aparte)

Búsqueda de fotos de eventos deportivos por dorsal. Proyecto **aparte**:
no toca el proyecto de Bolt de Orlan. App en español.

## Qué hace

- **Cuentas reales:** registro / inicio de sesión con nombre, correo y
  contraseña (guardada con hash scrypt, nunca en texto plano).
- **Un solo fotógrafo:** la primera cuenta de fotógrafo que se crea es la
  única. Un segundo intento de crear cuenta de fotógrafo es rechazado.
  Las demás cuentas son de deportista / corredor.
- **Fotógrafo:** crea eventos (nombre, deporte, fecha, lugar), sube fotos,
  pone el precio y gestiona eventos y fotos.
- **Deportistas:** buscan fotos por dorsal en todos los eventos o dentro
  de un evento. La búsqueda usa los dorsales **etiquetados a mano al subir**
  (campo "Dorsales", separados por coma). No hay lectura automática por IA
  en esta versión: el etiquetado manual es el núcleo fiable.
- **Descarga gratis por defecto:** los eventos nacen en modo gratis. El
  deportista descarga la foto en tamaño completo, sin marca de agua y sin
  pagar. La descarga queda registrada en "Mis fotos" y se cuenta para el
  fotógrafo en "Descargas y ventas".
- **Cobro (opcional, por evento):** el fotógrafo puede cambiar un evento
  a "De pago" (precio por foto). La compra es **simulada**: no hay pasarela
  de pago real, no se cobra nada de verdad. Es el punto donde luego se
  conecta Stripe / Mercado Pago.
- **Botón Guardar:** un solo botón por foto que descarga el archivo desde
  una URL de mismo origen (`/api/photo?id=...`, con
  `Content-Disposition: attachment`). En Chrome Android eso dispara el
  gestor de descargas real. No usa blob URL (que la vista web de Muse
  descartaba en silencio) ni `navigator.share` como única vía.

## Qué NO se traslada desde el prototipo de Muse

- **Las cuentas no se trasladan.** Orlan debe crear su cuenta de
  fotógrafo primero en la versión desplegada, antes que nadie.
- **Las fotos no se trasladan.** Hay que volver a subir las 4 fotos de
  "Ensenada medio" (y etiquetar sus dorsales: 223, 426, 161) en el evento
  nuevo.
- El proyecto de Bolt queda intacto: esto es un proyecto nuevo y aparte.

## Stack

- Frontend: HTML + JS vainilla en `public/` (sin build).
- Backend: funciones serverless de Vercel en `api/` (Node, sin Express).
- Datos: dos adaptadores con la misma interfaz (`api/_lib/store.js`):
  - **Local (por defecto):** `data/` (JSON + archivos). Solo para probar
    en local. En Vercel NO persiste ni se comparte entre usuarios.
  - **Supabase (producción):** Postgres + Storage. Se activa poniendo
    `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY`. Es lo que hay que usar
    en Vercel para que los datos se compartan entre usuarios.

## Probar en local

```bash
npm install        # opcional en local (solo hace falta para Supabase)
npm run dev        # abre http://localhost:3000
npm test           # prueba automática: fotógrafo → evento → foto 223 →
                   # deportista → búsqueda 223 → descarga
```

## Desplegar en Vercel (pasos exactos)

### 1. Supabase (gratis, necesario para datos compartidos)

1. Crea cuenta en https://supabase.com y un proyecto nuevo (plan free).
2. En el proyecto: **SQL Editor → New query**, pega todo
   `supabase/schema.sql` y ejecuta. Crea las tablas `users`, `events`,
   `photos`, `downloads`.
3. En **Storage**, crea el bucket `photos` (puede ser privado; el
   servidor usa la service_role key).
4. En **Project Settings → API**, copia:
   - `Project URL` → variable `SUPABASE_URL`
   - `service_role` key (¡secreta, no la anon!) → `SUPABASE_SERVICE_ROLE_KEY`

### 2. Vercel

Opción A — desde el panel (sin terminal):

1. Crea cuenta en https://vercel.com.
2. Sube este código a un repositorio de GitHub (nuevo repo, aparte del
   de Bolt) e impórtalo en Vercel: **Add New → Project → Import**.
3. En **Environment Variables**, añade:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `AUTH_SECRET` (una frase larga y secreta inventada por ti; protege
     las sesiones. Si no la pones, usa un valor de desarrollo: cámbialo).
4. **Deploy.** Vercel te dará un link `https://onlyclick-....vercel.app`.
   Ese es el link para abrir en Chrome y mandar a los corredores.

Opción B — con la CLI:

```bash
npm i -g vercel
vercel login
vercel --prod
# Cuando pregunte por variables, añade las tres de arriba en el panel
# o con: vercel env add SUPABASE_URL production
```

### 3. Primeros pasos en la app ya desplegada

1. Abre el link en Chrome.
2. **Crea primero tu cuenta de fotógrafo** (Crear cuenta → Soy fotógrafo).
   Si alguien crea otra antes, esa será la única y habrá que borrarla
   en Supabase.
3. Crea el evento "Ensenada medio" y sube las 4 fotos con sus dorsales.
4. Crea una cuenta de deportista (otro correo) y prueba: buscar 223 →
   Guardar → la foto debe aparecer en Descargas / galería.
5. Invita corredores con el link: ellos crean cuenta de deportista,
   buscan su dorsal y descargan gratis.

## Variables de entorno

| Variable | Obligatoria | Para qué |
|---|---|---|
| `SUPABASE_URL` | Sí (en Vercel) | Proyecto Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Sí (en Vercel) | Acceso servidor a Supabase |
| `AUTH_SECRET` | Recomendada | Firmar sesiones |
| `PORT` | No (local) | Puerto del servidor local (3000) |

Sin `SUPABASE_*`, la app arranca con el adaptador de archivo local:
funciona para probar, pero en Vercel cada usuario vería datos distintos
y se perderían al reiniciar. No lo uses en producción.

## Límites conocidos (honestos)

- **Descarga verificada en local, no en un teléfono Android real.**
  El flujo (`/api/photo` con `Content-Disposition: attachment`, URL de
  mismo origen) es el mecanismo estándar que Chrome Android usa para
  descargar archivos, y la prueba automática comprueba que el servidor
  devuelve los bytes con esa cabecera. Que la foto aparezca en la
  galería del teléfono solo lo confirma Orlan probándolo en Chrome
  con el link desplegado.
- **Sin lectura automática de dorsales por IA.** Hay que escribir el
  dorsal al subir cada foto (o editarlo después en el panel).
- **Sin marca de agua en la vista previa de eventos de pago.** La
  descarga original sí está protegida por compra, pero la vista previa
  muestra la foto completa. Antes de cobrar de verdad, añade marca de
  agua y una pasarela real (Stripe / Mercado Pago).
- **Sin pago real.** La "compra" solo registra el importe; no cobra.
- La contraseña se guarda con hash, pero no hay recuperación de
  contraseña por correo todavía.
