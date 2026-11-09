// Keeps the app shell and every song you have opened available offline.
const VERSION = "v1";
const STATIC_CACHE = `freetar-static-${VERSION}`;
const PAGE_CACHE = `freetar-pages-${VERSION}`;
const PAGE_TIMEOUT_MS = 4000;

const SHELL = [
    "/static/bootstrap/bootstrap.min.css",
    "/static/bootstrap/bootstrap.bundle.min.js",
    "/static/custom.css",
    "/static/custom.js",
    "/static/audio.css",
    "/static/audio-engine.js",
    "/static/tuner.js",
    "/static/follow-match.js",
    "/static/tab-follower.js",
    "/static/vendor/pitchy.js",
    "/static/vendor/meyda.js",
    "/static/vendor/tonal.js",
    "/static/guitar.png",
];

self.addEventListener("install", event => {
    event.waitUntil(
        caches.open(STATIC_CACHE)
            .then(cache => cache.addAll(SHELL))
            .then(() => caches.open(PAGE_CACHE))
            .then(cache => cache.add("/").catch(() => {}))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener("activate", event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys
                .filter(key => key.startsWith("freetar-") && ![STATIC_CACHE, PAGE_CACHE].includes(key))
                .map(key => caches.delete(key))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener("fetch", event => {
    const request = event.request;
    const url = new URL(request.url);
    if (request.method !== "GET" || url.origin !== self.location.origin) return;

    if (request.mode === "navigate") {
        event.respondWith(networkFirst(request));
    } else if (url.pathname.startsWith("/static/")) {
        event.respondWith(staleWhileRevalidate(request));
    }
});

async function networkFirst(request) {
    const cache = await caches.open(PAGE_CACHE);
    const cached = await cache.match(request);
    const network = fetch(request).then(response => {
        if (response.ok) cache.put(request, response.clone());
        return response;
    });
    // Only give up on a slow network when there is a saved copy to show instead;
    // new songs can take a while because the server fetches them from Ultimate Guitar.
    try {
        return await (cached ? withTimeout(network, PAGE_TIMEOUT_MS) : network);
    } catch {
        return cached || offlinePage();
    }
}

async function staleWhileRevalidate(request) {
    const cache = await caches.open(STATIC_CACHE);
    const cached = await cache.match(request);
    const network = fetch(request)
        .then(response => {
            if (response.ok) cache.put(request, response.clone());
            return response;
        })
        .catch(() => cached);
    return cached || network;
}

function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timeout")), ms);
        promise.then(
            value => { clearTimeout(timer); resolve(value); },
            error => { clearTimeout(timer); reject(error); },
        );
    });
}

function offlinePage() {
    return new Response(
        `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Freetar - offline</title>
        <body style="font-family: system-ui; padding: 2rem; background: #212529; color: #f8f9fa">
        <h1>Can't reach Freetar</h1>
        <p>This device can't connect to the Freetar server right now. Make sure you're on the
        same Wi-Fi as the computer running it.</p>
        <p>This page hasn't been opened before, so it isn't saved on this device.
        Songs you've already opened still work.</p>
        <p><button onclick="location.reload()" style="font-size: 1rem; padding: .5rem 1rem">Try again</button>
        &nbsp; <a href="/" style="color: #6ea8fe">Home page</a></p>`,
        { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
}
