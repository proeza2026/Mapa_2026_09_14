// ============================================================
// PROEZA - SERVICE WORKER SEMANAL
// Cada repositorio de GitHub Pages queda aislado de los demás.
// ============================================================

const REPO_ID = (() => {
  try {
    const scopePath = new URL(self.registration.scope).pathname;
    const partes = scopePath.split("/").filter(Boolean);
    const repo = partes.length > 0 ? partes[0] : "raiz";

    return repo
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "") || "raiz";
  } catch (e) {
    return "raiz";
  }
})();

const APP_CACHE_PREFIX = `proeza-app-${REPO_ID}-`;
const APP_CACHE = `${APP_CACHE_PREFIX}v1`;
const ZONE_CACHE_PREFIX = `proeza-zona-${REPO_ID}-`;

self.addEventListener("install", event => {
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    (async () => {
      const nombres = await caches.keys();

      // Borra solamente versiones antiguas de la APP de ESTE repositorio.
      // Nunca borra las zonas descargadas y nunca toca otro repositorio.
      await Promise.all(
        nombres
          .filter(nombre =>
            nombre.startsWith(APP_CACHE_PREFIX) &&
            nombre !== APP_CACHE
          )
          .map(nombre => caches.delete(nombre))
      );

      await self.clients.claim();
    })()
  );
});

function esArchivoDatos(url) {
  const path = url.pathname.toLowerCase();

  return (
    path.endsWith(".csv") ||
    path.endsWith(".kml") ||
    path.endsWith(".json") ||
    path.endsWith(".xlsx")
  );
}

function requestCanonicaDatos(request) {
  const u = new URL(request.url);

  // El parámetro _fresh sirve solo para obligar a consultar la versión actual.
  // Nunca forma parte de la clave final de caché.
  u.searchParams.delete("_fresh");

  return new Request(u.href, {
    method: "GET",
    credentials: "same-origin"
  });
}

async function buscarEnZonas(requestCanonica) {
  const nombres = await caches.keys();

  const zonas = nombres.filter(nombre =>
    nombre.startsWith(ZONE_CACHE_PREFIX)
  );

  // Primero revisa las zonas más recientes.
  for (let i = zonas.length - 1; i >= 0; i--) {
    const cache = await caches.open(zonas[i]);
    const encontrado = await cache.match(requestCanonica);

    if (encontrado) return encontrado;
  }

  return null;
}

async function obtenerDatosActuales(request) {
  const cache = await caches.open(APP_CACHE);
  const canonica = requestCanonicaDatos(request);

  try {
    // ONLINE:
    // siempre GitHub primero y sin utilizar el caché HTTP del navegador.
    const response = await fetch(request, {
      cache: "no-store"
    });

    if (!response || !response.ok) {
      throw new Error(`Respuesta de datos no válida: ${response ? response.status : "sin respuesta"}`);
    }

    // Una sola copia canónica vigente por CSV/KML.
    await cache.put(canonica, response.clone());

    return response;

  } catch (error) {
    // OFFLINE:
    // 1. última copia canónica de la aplicación.
    let cached = await cache.match(canonica);
    if (cached) return cached;

    // 2. como respaldo, buscar el mismo archivo dentro de las zonas
    //    descargadas de ESTE repositorio semanal.
    cached = await buscarEnZonas(canonica);
    if (cached) return cached;

    throw error;
  }
}

async function obtenerNavegacionActual(request) {
  const cache = await caches.open(APP_CACHE);

  const canonicalIndex = new Request(
    new URL("./index.html", self.registration.scope).href,
    { method: "GET", credentials: "same-origin" }
  );

  try {
    // ONLINE: siempre intentar la versión actual del index.
    const response = await fetch(request, {
      cache: "no-store"
    });

    if (!response || !response.ok) {
      throw new Error("No fue posible obtener el index actual.");
    }

    await cache.put(canonicalIndex, response.clone()).catch(() => {});

    return response;

  } catch (error) {
    // OFFLINE: usar el último index guardado.
    let cached = await cache.match(canonicalIndex);
    if (cached) return cached;

    cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;

    return new Response(
      "El visor no está disponible sin conexión. Prepará la zona antes de salir.",
      {
        status: 503,
        headers: {
          "Content-Type": "text/plain; charset=utf-8"
        }
      }
    );
  }
}

self.addEventListener("fetch", event => {
  const request = event.request;

  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // ==========================================================
  // 1. VISOR
  // ONLINE  -> GitHub actual
  // OFFLINE -> último index guardado
  // ==========================================================
  if (request.mode === "navigate") {
    event.respondWith(
      obtenerNavegacionActual(request)
    );
    return;
  }

  // ==========================================================
  // 2. CSV / KML / JSON / XLSX DEL REPOSITORIO
  // ONLINE  -> SIEMPRE red primero
  // OFFLINE -> UNA sola copia canónica vigente
  // ==========================================================
  if (
    url.origin === self.location.origin &&
    esArchivoDatos(url)
  ) {
    event.respondWith(
      obtenerDatosActuales(request).catch(() =>
        new Response(
          "Recurso de datos no disponible sin conexión.",
          {
            status: 503,
            headers: {
              "Content-Type": "text/plain; charset=utf-8"
            }
          }
        )
      )
    );
    return;
  }

  // ==========================================================
  // 3. RESTO DE RECURSOS
  // Librerías, mapa base, logo, etc.
  // Cache-first para conservar funcionamiento offline.
  // ==========================================================
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;

      return fetch(request).then(response => {
        if (
          response &&
          (response.ok || response.type === "opaque")
        ) {
          const copia = response.clone();

          caches.open(APP_CACHE).then(cache => {
            cache.put(request, copia).catch(() => {});
          });
        }

        return response;
      });
    })
  );
});
