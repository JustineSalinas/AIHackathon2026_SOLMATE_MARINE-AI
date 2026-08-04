
    if ('serviceWorker' in navigator) {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('/sw.js')
                .then(prewarmDemoTiles)
                .catch(err => {
                    console.log('SW registration failed: ', err);
                });
        });
    }

    // Pre-warm the demo area's map tiles.
    //
    // Caching tiles in the service worker only helps the SECOND time a tile is
    // asked for. On a cold browser at a venue, the first paint is still a race
    // against the wifi -- which is the failure this is here to remove: the chart
    // rendering as place labels over empty water, and the helm view as a boat on
    // a flat field. Fetching the demo box up front means the tiles are already in
    // the cache by the time anyone drags the map, and they stay there even if the
    // network dies mid-pitch.
    //
    // Deliberately bounded. This runs at idle, a few requests at a time, and stops
    // at the overview zooms that the wide shots actually use. Pulling the whole
    // route at street zoom would be thousands of tiles, would evict itself against
    // the cache cap, and would saturate the very connection it is trying to protect.
    function prewarmDemoTiles() {
        // Iloilo Strait: the demo crossing, Iloilo City <-> Guimaras.
        const BOX = { south: 10.55, north: 10.80, west: 122.45, east: 122.75 };
        const ZOOMS = [11, 12, 13];
        const CONCURRENCY = 4;

        const lonToX = (lon, z) => Math.floor(((lon + 180) / 360) * Math.pow(2, z));
        const latToY = (lat, z) => {
            const r = (lat * Math.PI) / 180;
            return Math.floor(
                ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * Math.pow(2, z),
            );
        };

        const urls = [];
        for (const z of ZOOMS) {
            const x0 = lonToX(BOX.west, z), x1 = lonToX(BOX.east, z);
            const y0 = latToY(BOX.north, z), y1 = latToY(BOX.south, z);
            for (let x = x0; x <= x1; x++) {
                for (let y = y0; y <= y1; y++) {
                    // Esri {z}/{y}/{x} — note the axis order differs from the XYZ
                    // convention the other two use. Getting this backwards fetches
                    // valid-looking tiles for the wrong place, silently.
                    urls.push(`https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`);
                    urls.push(`https://a.basemaps.cartocdn.com/rastertiles/voyager_only_labels/${z}/${x}/${y}.png`);
                    urls.push(`https://a.basemaps.cartocdn.com/dark_all/${z}/${x}/${y}.png`);
                }
            }
        }

        let i = 0;
        const pump = () => {
            if (i >= urls.length) return Promise.resolve();
            const url = urls[i++];
            // no-cors: these are the same opaque responses the <img> tags produce,
            // so the service worker stores exactly the entry the map will later ask
            // for. A cors fetch would cache under a different request and miss.
            return fetch(url, { mode: 'no-cors', cache: 'default' })
                .catch(() => undefined)
                .then(pump);
        };

        const start = () => {
            const workers = [];
            for (let w = 0; w < CONCURRENCY; w++) workers.push(pump());
            Promise.all(workers).then(() => {
                console.info(`[marine-ai] pre-warmed ${urls.length} demo tiles`);
            });
        };

        // Never compete with first paint or with the app's own API calls.
        if ('requestIdleCallback' in window) {
            requestIdleCallback(start, { timeout: 8000 });
        } else {
            setTimeout(start, 3000);
        }
    }
