# Agro Cordobés — sitio estático con noticias automáticas

Construido sobre el mismo sistema de noticordoba.com.ar (repo:
`github.com/damianestebanmartin-alt/noticordoba`), adaptado a Agro Cordobés:
mismo motor por debajo (Google News + microlink.io + cabecera.json + GitHub
Pages/Cloudflare), pero con las 3 categorías de campo/agro y el diseño
visual calcado del sitio real en WordPress (agrocordobes.com.ar): sin
botonera de categorías arriba, header simple (logo + fecha) con el banner
de publicidad al lado, clima y cotización del dólar solo en la primera
fila, y tarjetas blancas con imagen + badge verde + título + bajada +
"LEER NOTA »" + fecha.

Sitio 100% estático (HTML/CSS/JS en un solo `index.html`, sin backend, sin
base de datos, sin login). Sin panel de admin ni CMS que parchear — no hay
superficie de ataque que un bot pueda escanear ni explotar.

## Cómo funciona

```
Cron diario (GitHub Actions, 9am ARG)
  → lee feeds RSS de Google News (por categoría: Info Campo, Agro Verdad, Todo Agro)
  → normaliza cada nota, le asigna categoría
  → busca imagen real vía microlink.io (API externa)
  → guarda todo en data/data.json (rotación de últimas 30 notas)
  → commitea el cambio al repo
      → GitHub Pages redespliega automático al detectar el push
```

## Estructura de archivos

```
index.html            # todo el sitio: HTML + CSS + JS inline, un solo archivo
.nojekyll              # vacío; le dice a GitHub Pages que no procese con Jekyll
CNAME                   # contiene "agrocordobes.com.ar"
scripts/
  fetch-news.js           # el bot: lee RSS, clasifica, busca imágenes, guarda
data/
  feeds.json                # config de fuentes RSS por categoría (editable a mano)
  data.json                  # las notas actuales (lo genera/sobreescribe el bot)
  cabecera.json                # banner(s) publicitario(s)
assets/
  logo.png                       # logo de Agro Cordobés
  favicon.png                     # ícono para la pestaña del navegador
  (acá van los banners que subas)
.github/workflows/
  update-news.yml                  # cron diario + botón de "run manual"
```

## Decisiones heredadas de noticordoba (no las repitas al revés)

Estas son gotchas ya resueltos ahí — se mantuvieron igual acá a propósito:

1. **Nunca renombres `cabecera.json` a `banner.json`**, ni la clase
   `.cabecera-wrap`, ni el id `#cabecera`. La mayoría de los ad-blockers
   bloquean automáticamente cualquier request a una URL que contenga la
   palabra "banner" (`net::ERR_BLOCKED_BY_CLIENT`). Si reintroducís esa
   palabra en cualquier nombre de archivo/clase/id, el banner deja de
   cargar para una porción grande de visitantes, sin ningún error visible
   en el sitio (solo en la consola del navegador).
2. **Las imágenes de Google Drive no sirven insertadas** (`<img src="...">`)
   en una página ajena, aunque el link funcione perfecto abierto directo.
   Drive quiere que sea "embebido". Mejor: subí las imágenes directo a
   `assets/` en el repo, no dependas de un link de Drive para el `src`.
3. **La Voz del Interior bloquea scraping directo con 403** (protección
   tipo Cloudflare, no importa el User-Agent). Por eso no se le pide RSS
   directo a los portales: se usa Google News como agregador (ver punto 4).
4. **Se usa Google News RSS** en vez de pedirle el RSS a cada portal
   directamente — evita bloqueos de bots y trae de varios medios a la vez.
   El `<source>` de cada item trae el nombre real del medio (Infocampo,
   Bichos de Campo, La Voz, etc.), y el código lo usa en vez del nombre
   genérico del feed.
5. **El link de Google News es un redirect que requiere JavaScript**, un
   fetch simple del servidor no llega al artículo real. Por eso, para
   sacar la imagen de portada, se usa la API gratuita de microlink.io
   (renderiza con navegador real por detrás). Límite gratis: 50
   pedidos/día compartido por IP — si falla, el código cae a un
   placeholder propio, no rompe nada (`try/catch` en `fetch-news.js`).
6. **Placeholder de imagen propio en SVG inline**, sin depender de
   servicios externos tipo `via.placeholder.com` (ese cerró). Nunca
   depender de un placeholder externo de nuevo.
7. **Rotación de banners empieza en un índice al azar**, no siempre en 0
   — si no, con visitas cortas el primer banner se ve casi siempre y el
   segundo casi nunca. La línea clave en `index.html` es
   `let i = Math.floor(Math.random() * elementos.length);`.

## Categorías de Agro Cordobés

`Info Campo`, `Agro Verdad`, `Todo Agro` — mismos nombres que ya usaba la
versión en WordPress. El bot clasifica cada nota con un diccionario de
palabras clave sobre el título cuando el feed no trae `<category>` propia
(función `normalizarCategoria` en `scripts/fetch-news.js`), y esa categoría
se muestra como badge verde sobre la imagen de cada tarjeta. A diferencia
de noticordoba, acá **no hay botonera de categorías para filtrar** — el
sitio real de Agro Cordobés en WordPress tampoco la tiene, todas las notas
se muestran mezcladas por fecha en la portada. Las queries de Google News
en `data/feeds.json` son un punto de partida — antes de lanzar, abrí cada
URL en el navegador y confirmá que devuelve XML con `<item>` adentro.

## Formato de cada nota en `data/data.json`

```json
{
  "titulo": "...",
  "link": "...",
  "fuente": "Infocampo",
  "categoria": "Info Campo",
  "bajada": "resumen corto de 1-2 líneas, sacado del RSS",
  "fecha": "ISO date",
  "imagen": "url o null"
}
```

La `bajada` es el resumen corto que se ve debajo del título en cada
tarjeta (igual que en el sitio real) — nunca el texto completo de la nota.

## Widgets de clima y cotización del dólar

Igual que la versión en WordPress, sumé estos dos junto a la cabecera:

- **Cotización del dólar**: ya viene funcionando, es un iframe en vivo de
  cotizacion-dolar.com.ar (su sección de "recursos para webmasters", de uso
  libre).
- **Clima (Meteored)**: requiere que lo generes vos, porque el código de
  embed es personal (depende de la ciudad y el estilo elegido). Entrá a
  [meteored.com.ar/widget](https://www.meteored.com.ar/widget/), elegí
  "Córdoba", copiá el `<script>` que te dan, y pegalo en `index.html`
  reemplazando el bloque marcado con `id="weather-widget-slot"`.

## Banner publicitario (`data/cabecera.json`)

```json
{
  "elementos": [
    { "imagen": "assets/mi-banner-septiembre.png", "link": "https://elsitiodelanunciante.com", "alt": "..." }
  ]
}
```

Un solo banner de forma normal (cambiás la imagen una vez al mes). Si en
algún momento tenés dos, agregás un segundo objeto y rotan solos cada 8
segundos, empezando en uno al azar. Acepta GIF animado sin ningún cambio,
es un `<img>` común.

## Puesta en marcha

1. **Repo en GitHub**: subí esta carpeta a un repo (puede ser el mismo
   `noticordoba` reusado como base, pero como sitio nuevo conviene uno
   propio, por ejemplo `agrocordobes-web`).
2. **Permisos del bot**: en GitHub, Settings → Actions → General →
   "Workflow permissions" → marcá "Read and write permissions" (así el bot
   puede comitear el `data.json` actualizado).
3. **GitHub Pages**: Settings → Pages → Source: rama `main`, carpeta `/`
   (raíz). Ahí mismo, en "Custom domain", poné `agrocordobes.com.ar` — eso
   genera/actualiza el `CNAME` del repo solo.
4. **DNS con Cloudflare** (porque NIC.ar no permite registros A/CNAME
   propios, solo delegar a otro proveedor de nameservers):
   - Creá una cuenta gratis en Cloudflare y agregá el dominio
     `agrocordobes.com.ar`. Te va a dar 2 nameservers.
   - En NIC.ar, sección "Delegaciones" del dominio, configurá esos 2
     nameservers de Cloudflare.
   - Dentro de Cloudflare, sección DNS, creá:
     - 4 registros **A** en `@` apuntando a las IPs de GitHub Pages:
       `185.199.108.153`, `185.199.109.153`, `185.199.110.153`,
       `185.199.111.153`
     - 1 registro **CNAME** en `www` apuntando a
       `<tu-usuario-de-github>.github.io`
     - Todos con el proxy de Cloudflare **apagado** ("DNS only", nube
       gris) — si queda en "Proxied" (nube naranja), interfiere con la
       verificación de dominio y el certificado SSL de GitHub Pages.
5. **HTTPS**: lo emite GitHub automáticamente (Let's Encrypt) una vez que
   el DNS termina de propagar — de minutos a ~24hs, sin acción manual.
6. Podés correr el bot a mano en cualquier momento con
   `node scripts/fetch-news.js` (necesita Node 18+).

## Nota sobre derechos de autor

El sitio linkea siempre a la fuente y muestra solo el título + una imagen
de referencia (nunca el texto completo de la nota). Es el mismo modelo que
usan agregadores como Google News.
