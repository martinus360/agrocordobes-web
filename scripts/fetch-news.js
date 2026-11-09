// fetch-news.js
// Lee los feeds RSS configurados en data/feeds.json, saca las notas más
// recientes, arma el top 3 y mantiene un historial rotativo de 30 notas.
// No necesita ninguna librería externa: usa fetch nativo de Node 18+.
//
// Adaptado del sistema de noticordoba.com.ar (mismo código base, mismas
// decisiones ya resueltas ahí: Google News como agregador para evitar
// bloqueos de bots, microlink.io para resolver imágenes detrás de redirects
// de JS, placeholder propio en SVG). Ver README.md para el detalle de cada
// decisión y por qué está así.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FEEDS_PATH = path.join(__dirname, "..", "data", "feeds.json");
const DATA_PATH = path.join(__dirname, "..", "data", "data.json");
const VIDEOS_PATH = path.join(__dirname, "..", "data", "videos.json");
const MAX_HISTORIAL = 30;
const TOP_N = 3;

// --- utilidades de parseo XML muy simples (sin dependencias) ---

function extraerTag(xml, tag) {
  // busca <tag>...</tag> o <tag ...>...</tag>, soporta CDATA
const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const m = xml.match(re);
  if (!m) return null;
  return m[1]
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, "$1")
  .replace(/&amp;/g, "&")
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .trim();
}

function extraerAtributo(xml, tag, atributo) {
  const re = new RegExp(`<${tag}[^>]*${atributo}=["']([^"']+)["'][^>]*/?>`, "i");
  const m = xml.match(re);
  return m ? m[1] : null;
}

function extraerItems(xml) {
  // sirve tanto para RSS (<item>) como para Atom (<entry>)
const esAtom = !xml.includes("<item") && xml.includes("<entry");
  const tagItem = esAtom ? "entry" : "item";
  const re = new RegExp(`<${tagItem}[^>]*>([\\s\\S]*?)</${tagItem}>`, "gi");
  const items = [];
  let m;
  while ((m = re.exec(xml)) !== null) {
    items.push(m[1]);
  }
  return items;
}

// Categorías reales del menú de navegación/filtro del sitio (ver index.html).
// Antes usábamos "Info Campo" / "Agro Verdad" / "Todo Agro", que en realidad
// son nombres de otros medios y confundían a los lectores (parecía que el
// sitio solo tomaba notas de esos 2-3 portales). Ahora son categorías por
// tema, así el filtro le sirve de verdad al productor.
const CATEGORIAS_VALIDAS = ["Agricultura", "Ganadería", "Mercados & Cotizaciones", "Clima", "Maquinaria"];

// A las notas que ya estén guardadas en data.json con las categorías viejas
// (de antes de este cambio) las reasignamos a la categoría nueva más
// parecida, así el filtro no se rompe con notas "huérfanas" hasta que
// salgan del historial por su cuenta.
const MIGRACION_CATEGORIAS_VIEJAS = {
  "Info Campo": "Clima",
  "Agro Verdad": "Mercados & Cotizaciones",
  "Todo Agro": "Agricultura",
};

function migrarCategoriaVieja(categoria) {
  return MIGRACION_CATEGORIAS_VIEJAS[categoria] || categoria;
}

// Diccionario de palabras clave para normalizar cualquier <category> del RSS,
// o el propio título, a una de las categorías del menú de Agro Cordobés.
const PALABRAS_CLAVE = {
  "Clima": ["clima", "pronostico", "pronóstico", "lluvia", "lluvias", "sequia", "sequía", "helada", "heladas", "granizo", "tormenta", "temperatura", "meteorologico", "meteorológico"],
  "Mercados & Cotizaciones": ["dolar", "dólar", "cotizacion", "cotización", "precio", "precios", "mercado", "mercados", "exportacion", "exportación", "importacion", "importación", "bolsa de cereales", "futuros", "paritaria", "retencion", "retención", "euro"],
  "Ganadería": ["hacienda", "ganaderia", "ganadería", "vacuno", "vacunos", "feedlot", "tambo", "lecheria", "lechería", "cerdo", "porcino", "aviar", "pollo", "invernada", "cria de", "cría de", "exposicion rural", "exposición rural", "rodeo"],
  "Maquinaria": ["maquinaria", "tractor", "cosechadora", "sembradora", "pulverizadora", "implemento", "implementos", "agtech", "tecnologia agricola", "tecnología agrícola", "expoagro", "fierros"],
  "Agricultura": ["soja", "maiz", "maíz", "trigo", "cosecha", "siembra", "grano", "granos", "cultivo", "cultivos", "vendimia", "vinedo", "viñedo", "girasol", "sorgo", "cebada", "mani", "maní"],
};

function normalizarCategoria(textoCrudo, categoriaPorDefecto) {
  if (textoCrudo) {
    const t = textoCrudo.toLowerCase();
    for (const cat of CATEGORIAS_VALIDAS) {
      if (t.includes(cat.toLowerCase())) return cat;
    }
    for (const [cat, palabras] of Object.entries(PALABRAS_CLAVE)) {
      if (palabras.some((p) => t.includes(p))) return cat;
    }
  }
  const porDefectoMigrada = migrarCategoriaVieja(categoriaPorDefecto);
  return CATEGORIAS_VALIDAS.includes(porDefectoMigrada) ? porDefectoMigrada : "Agricultura";
}

function limpiarHtml(raw) {
  if (!raw) return "";
  return raw.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

// Saca acentos y pasa a minúscula, para poder comparar texto sin importar
// mayúsculas/acentos ("Córdoba", "CORDOBA", "cordobés" deben matchear igual).
function normalizarTexto(texto) {
  return (texto || "")
  .toLowerCase()
  .normalize("NFD")
  .replace(/\p{Diacritic}/gu, "");
}

function mencionaCordoba(texto) {
  return normalizarTexto(texto).includes("cordob");
}

// Ojo: NO alcanza con mirar el dominio de la imagen. Google también re-aloja
// fotos reales de cada nota en googleusercontent.com (cada una con su propia
// URL), así que bloquear todo ese dominio tira abajo fotos válidas. La única
// señal confiable de "ícono genérico de Google" es que la MISMA URL se repite
// en varias notas distintas (eso sí es un placeholder, nunca una foto real).
// Por eso la limpieza se hace después, comparando todas las notas entre sí
// (ver limpiarImagenesDuplicadas), no acá por nota individual.

function parsearItem(itemXml, nombreFuente, categoriaPorDefecto) {
  let titulo = extraerTag(itemXml, "title") || "Sin título";
  const categoriaRss = extraerTag(itemXml, "category");
  const categoria = normalizarCategoria(categoriaRss || titulo, categoriaPorDefecto);

// Si viene de Google News, <source> trae el nombre del medio real
// (Infocampo, Bichos de Campo, La Voz, etc.) y el título suele traer
// " - Medio" al final.
const fuenteReal = extraerTag(itemXml, "source");
  if (fuenteReal && titulo.endsWith(" - " + fuenteReal)) {
    titulo = titulo.slice(0, -(" - " + fuenteReal).length);
  }

// Bajada corta para mostrar debajo del título (nunca la nota completa).
// Ojo: la <description> de Google News casi nunca trae un resumen real:
// en general es el mismo título de vuelta, seguido del nombre de la
// fuente. Si al sacarle la fuente queda exactamente el título, no hay
// nada nuevo que mostrar: mejor dejar la bajada vacía que repetir el
// título dos veces en la tarjeta.
let bajada = limpiarHtml(extraerTag(itemXml, "description"));
  if (fuenteReal && bajada.endsWith(fuenteReal)) {
    bajada = bajada.slice(0, bajada.length - fuenteReal.length).trim();
  }
  const bajadaEsRedundante = !bajada || bajada.toLowerCase() === titulo.toLowerCase();
  bajada = bajadaEsRedundante ? "" : bajada.slice(0, 160);

let link = extraerTag(itemXml, "link");
  if (!link) {
    // Atom suele usar <link href="..."/>
  link = extraerAtributo(itemXml, "link", "href");
  }

const pubDateRaw =
  extraerTag(itemXml, "pubDate") ||
  extraerTag(itemXml, "published") ||
  extraerTag(itemXml, "updated") ||
  new Date().toISOString();
  const fecha = new Date(pubDateRaw);

// Imagen: probamos media:content, enclosure, o una <img> dentro de description
let imagen =
  extraerAtributo(itemXml, "media:content", "url") ||
  extraerAtributo(itemXml, "enclosure", "url");

if (!imagen) {
  const desc = extraerTag(itemXml, "description") || "";
  const imgMatch = desc.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (imgMatch) imagen = imgMatch[1];
}

return {
  titulo,
  link,
  fuente: fuenteReal || nombreFuente,
  categoria,
  bajada,
  fecha: isNaN(fecha) ? new Date().toISOString() : fecha.toISOString(),
  imagen: imagen || null,
};
}

async function leerFeed(fuente) {
  try {
    const res = await fetch(fuente.rss, {
      headers: {
        "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "application/rss+xml, application/xml, text/xml, */*",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      console.warn(`[${fuente.nombre}] respondió ${res.status}, se salta.`);
      return [];
    }
    const xml = await res.text();
    const items = extraerItems(xml).slice(0, 10); // no hace falta más de 10 por fuente
  // Los feeds nacionales (soloCordoba: true) cubren todo el país: acá
  // descartamos, antes de parsear, cualquier item que no mencione Córdoba
  // en ningún lado (título, descripción, categorías vienen todos en el
  // XML crudo del item, así que alcanza con buscar sobre ese texto).
  const itemsFiltrados = fuente.soloCordoba
    ? items.filter((it) => mencionaCordoba(it))
    : items;
    return itemsFiltrados
    .map((it) => parsearItem(it, fuente.nombre, fuente.categoria))
    .filter((n) => n.link); // descartamos notas sin link, no sirven
  } catch (err) {
    console.warn(`[${fuente.nombre}] error al leer el feed: ${err.message}`);
    return [];
  }
}

// Compara dos títulos por palabras en común (ignorando acentos/mayúsculas y
// palabras muy cortas, que no aportan al tema). Sirve para detectar la misma
// noticia real cubierta por dos medios distintos, aunque el título no sea
// idéntico palabra por palabra.
function palabrasClaveDeTitulo(titulo) {
  return normalizarTexto(titulo)
  .replace(/[^a-z0-9\s]/g, " ")
  .split(/\s+/)
  .filter((p) => p.length > 3);
}

function sonMismoTema(a, b) {
  const palabrasA = new Set(palabrasClaveDeTitulo(a.titulo));
  const palabrasB = new Set(palabrasClaveDeTitulo(b.titulo));
  if (palabrasA.size === 0 || palabrasB.size === 0) return false;
  let comunes = 0;
  for (const p of palabrasA) if (palabrasB.has(p)) comunes++;
  return comunes / Math.min(palabrasA.size, palabrasB.size) >= 0.6;
}

function quitarDuplicadosPorTema(notas) {
  const resultado = [];
  for (const nota of notas) {
    if (!resultado.some((n) => sonMismoTema(n, nota))) {
      resultado.push(nota);
    }
  }
  return resultado;
}

async function buscarImagenDeArticulo(url) {
  try {
    const apiUrl =
      "https://api.microlink.io?url=" + encodeURIComponent(url) + "&meta=true";
    const res = await fetch(apiUrl, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.data?.image?.url || null;
  } catch {
    return null;
  }
}

function esperar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function elegirTop3(nuevoHistorial) {
  const candidatas = nuevoHistorial.slice(0, 12);

function intentar(requiereImagen, requiereFuenteDistinta) {
  const elegidas = [];
  const fuentesUsadas = new Set();
  for (const nota of candidatas) {
    if (requiereImagen && !nota.imagen) continue;
    if (requiereFuenteDistinta && fuentesUsadas.has(nota.fuente)) continue;
    elegidas.push(nota);
    fuentesUsadas.add(nota.fuente);
    if (elegidas.length === TOP_N) break;
  }
  return elegidas;
}

let elegidas = intentar(true, true);
  if (elegidas.length < TOP_N) elegidas = intentar(true, false);
  if (elegidas.length < TOP_N) elegidas = intentar(false, true);
  if (elegidas.length < TOP_N) elegidas = intentar(false, false);
  return elegidas;
}

async function buscarUltimoVideoDeCanal(canal, apiKey) {
  try {
    const url =
      "https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=" +
      encodeURIComponent(canal.channelId) +
      "&order=date&maxResults=1&type=video&key=" +
      encodeURIComponent(apiKey);
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) {
      console.warn(`[video: ${canal.nombre}] la API respondió ${res.status}, se salta.`);
      return null;
    }
    const data = await res.json();
    const item = data.items && data.items[0];
    if (!item || !item.id || !item.id.videoId) return null;
    const videoId = item.id.videoId;
    const snippet = item.snippet || {};
    const thumbs = snippet.thumbnails || {};
    const miniatura =
      (thumbs.high && thumbs.high.url) ||
      (thumbs.medium && thumbs.medium.url) ||
      (thumbs.default && thumbs.default.url) ||
      null;
    return {
      videoId,
      titulo: snippet.title || "",
      link: "https://www.youtube.com/watch?v=" + videoId,
      miniatura,
      canal: canal.nombre,
      categoria: canal.categoria || "",
      fecha: snippet.publishedAt || new Date().toISOString(),
    };
  } catch (err) {
    console.warn(`[video: ${canal.nombre}] error al consultar la API: ${err.message}`);
    return null;
  }
}

async function obtenerVideos(videosPrevios) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    console.warn("No hay YOUTUBE_API_KEY configurada: se deja el widget de videos como estaba.");
    return videosPrevios;
  }
  let canales = [];
  try {
    const contenido = JSON.parse(await readFile(VIDEOS_PATH, "utf-8"));
    canales = contenido.canales || [];
  } catch {
    return videosPrevios;
  }
  if (canales.length === 0) return videosPrevios;

const resultados = await Promise.all(
  canales.map((canal) => buscarUltimoVideoDeCanal(canal, apiKey))
  );
  const videosNuevos = resultados.filter(Boolean);
  return videosNuevos.length > 0 ? videosNuevos : videosPrevios;
}

async function main() {
  const { fuentes } = JSON.parse(await readFile(FEEDS_PATH, "utf-8"));

let historial = [];
  let videosPrevios = [];
  try {
    const previo = JSON.parse(await readFile(DATA_PATH, "utf-8"));
    historial = (previo.historial || []).map((n) => ({
      ...n,
      categoria: migrarCategoriaVieja(n.categoria),
    }));
    videosPrevios = previo.videos || [];
  } catch {
  }

// Notas que ya veníamos arrastrando de corridas anteriores: no les
// reintentamos la imagen todos los días si ya se había intentado antes
// (reintentar notas que ya fallaron agota la cuota gratis de microlink).
const linksYaVistos = new Set(historial.map((n) => n.link));

const [resultados, videos] = await Promise.all([
  Promise.all(fuentes.map(leerFeed)),
  obtenerVideos(videosPrevios),
  ]);
  const notasNuevas = resultados.flat();

if (notasNuevas.length === 0) {
  console.warn("No se pudo leer ninguna noticia de ningún feed. Se deja el data.json existente sin tocar.");
  return;
}

const porLink = new Map();
  for (const nota of [...notasNuevas, ...historial]) {
    if (!porLink.has(nota.link)) porLink.set(nota.link, nota);
  }
  const todasOrdenadas = [...porLink.values()].sort(
    (a, b) => new Date(b.fecha) - new Date(a.fecha)
    );

const todas = quitarDuplicadosPorTema(todasOrdenadas);

const nuevoHistorial = todas.slice(0, MAX_HISTORIAL);

function limpiarImagenesDuplicadas(notas) {
  const conteo = new Map();
  for (const n of notas) {
    if (n.imagen) conteo.set(n.imagen, (conteo.get(n.imagen) || 0) + 1);
  }
  for (const n of notas) {
    if (n.imagen && conteo.get(n.imagen) > 1) n.imagen = null;
  }
}

limpiarImagenesDuplicadas(nuevoHistorial);

// Buscamos imagen solo para notas nuevas de hoy, o para las que la
// limpieza de arriba les acaba de borrar la imagen (merecen reintento).
// Una nota vieja que ya viene fallando desde antes no se reintenta todos
// los días. Además los pedimos de a uno, con pausa entre cada uno: el
// plan gratis de microlink limita los pedidos por segundo, y pedirlos
// todos en paralelo hacía que casi todos volvieran con error.
const MAX_BUSQUEDAS_IMAGEN_POR_CORRIDA = 15;
  let busquedasHechas = 0;
  for (const nota of nuevoHistorial) {
    if (nota.imagen) continue;
    if (linksYaVistos.has(nota.link)) continue;
    if (busquedasHechas >= MAX_BUSQUEDAS_IMAGEN_POR_CORRIDA) break;
    nota.imagen = await buscarImagenDeArticulo(nota.link);
    busquedasHechas++;
    await esperar(1200);
  }

limpiarImagenesDuplicadas(nuevoHistorial);

const top3 = elegirTop3(nuevoHistorial);

const salida = {
  actualizado: new Date().toISOString(),
  top3,
  historial: nuevoHistorial,
  videos,
};

await writeFile(DATA_PATH, JSON.stringify(salida, null, 2), "utf-8");
  console.log(`Listo: ${nuevoHistorial.length} notas en historial, top3 con ${top3.length}, ${videos.length} videos. Imágenes buscadas esta corrida: ${busquedasHechas}.`);
}

main().catch((err) => {
  console.error("Error general:", err);
  process.exit(1);
});
