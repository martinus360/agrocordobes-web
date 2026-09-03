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

const CATEGORIAS_VALIDAS = ["Info Campo", "Agro Verdad", "Todo Agro"];

// Diccionario de palabras clave para normalizar cualquier <category> del RSS,
// o el propio título, a una de las 3 categorías del menú de Agro Cordobés.
const PALABRAS_CLAVE = {
  "Info Campo": ["clima", "pronostico", "pronóstico", "lluvia", "sequia", "sequía", "paritaria", "dolar", "dólar", "cotizacion", "cotización", "euro", "helada", "granizo"],
  "Agro Verdad": ["ruta", "camino rural", "obra", "infraestructura", "politica agropecuaria", "política agropecuaria", "gestion", "gestión", "provincia", "municipio", "ministerio de agricultura", "senasa", "retencion", "retención"],
  "Todo Agro": ["soja", "maiz", "maíz", "trigo", "cosecha", "siembra", "grano", "hacienda", "ganaderia", "ganadería", "exportacion", "exportación", "mercado", "bolsa de cereales", "vendimia", "vinedo", "viñedo"],
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
  return CATEGORIAS_VALIDAS.includes(categoriaPorDefecto) ? categoriaPorDefecto : "Todo Agro";
}

function limpiarHtml(raw) {
  if (!raw) return "";
  return raw.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function parsearItem(itemXml, nombreFuente, categoriaPorDefecto) {
  let titulo = extraerTag(itemXml, "title") || "Sin título";
  const categoriaRss = extraerTag(itemXml, "category");
  const categoria = normalizarCategoria(categoriaRss || titulo, categoriaPorDefecto);

  // Bajada corta para mostrar debajo del título (nunca la nota completa).
  const bajada = limpiarHtml(extraerTag(itemXml, "description")).slice(0, 160);

  // Si viene de Google News, <source> trae el nombre del medio real
  // (Infocampo, Bichos de Campo, La Voz, etc.) y el título suele traer
  // " - Medio" al final.
  const fuenteReal = extraerTag(itemXml, "source");
  if (fuenteReal && titulo.endsWith(" - " + fuenteReal)) {
    titulo = titulo.slice(0, -(" - " + fuenteReal).length);
  }

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
    return items
      .map((it) => parsearItem(it, fuente.nombre, fuente.categoria))
      .filter((n) => n.link); // descartamos notas sin link, no sirven
  } catch (err) {
    console.warn(`[${fuente.nombre}] error al leer el feed: ${err.message}`);
    return [];
  }
}

async function buscarImagenDeArticulo(url) {
  try {
    // microlink.io renderiza la página con un navegador real (headless),
    // así que sí puede seguir el redirect de Google News y otras páginas
    // que necesitan JavaScript para mostrar el contenido final.
    const apiUrl =
      "https://api.microlink.io?url=" + encodeURIComponent(url) + "&meta=true";
    const res = await fetch(apiUrl, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) return null; // incluye el caso de 429 (límite diario gratis agotado)
    const data = await res.json();
    return data?.data?.image?.url || null;
  } catch {
    return null; // si falla, la nota queda sin imagen y usa el placeholder, no rompe nada
  }
}

async function main() {
  const { fuentes } = JSON.parse(await readFile(FEEDS_PATH, "utf-8"));

  let historial = [];
  try {
    const previo = JSON.parse(await readFile(DATA_PATH, "utf-8"));
    historial = previo.historial || [];
  } catch {
    // primera corrida, no hay data.json todavía
  }

  const resultados = await Promise.all(fuentes.map(leerFeed));
  const notasNuevas = resultados.flat();

  if (notasNuevas.length === 0) {
    console.warn(
      "No se pudo leer ninguna noticia de ningún feed. Se deja el data.json existente sin tocar."
    );
    return;
  }

  // Unimos con el historial, sacamos duplicados por link, ordenamos por fecha desc
  const porLink = new Map();
  for (const nota of [...notasNuevas, ...historial]) {
    if (!porLink.has(nota.link)) porLink.set(nota.link, nota);
  }
  const todas = [...porLink.values()].sort(
    (a, b) => new Date(b.fecha) - new Date(a.fecha)
  );

  const nuevoHistorial = todas.slice(0, MAX_HISTORIAL);

  // A las notas que quedaron sin imagen, les vamos a buscar la foto de
  // portada real de la nota.
  await Promise.all(
    nuevoHistorial.map(async (nota) => {
      if (!nota.imagen) {
        nota.imagen = await buscarImagenDeArticulo(nota.link);
      }
    })
  );

  const top3 = nuevoHistorial.slice(0, TOP_N);

  const salida = {
    actualizado: new Date().toISOString(),
    top3,
    historial: nuevoHistorial,
  };

  await writeFile(DATA_PATH, JSON.stringify(salida, null, 2), "utf-8");
  console.log(
    `Listo: ${nuevoHistorial.length} notas en historial, top3 con ${top3.length}.`
  );
}

main().catch((err) => {
  console.error("Error general:", err);
  process.exit(1);
});
