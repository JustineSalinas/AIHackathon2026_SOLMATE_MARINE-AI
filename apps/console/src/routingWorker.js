class PriorityQueue {
    constructor() { this.data = []; }
    enqueue(element, priority) {
        this.data.push({ element, priority });
        this.data.sort((a, b) => a.priority - b.priority);
    }
    dequeue() { return this.data.shift(); }
    isEmpty() { return this.data.length === 0; }
}

let wasmMath = null;
let wasmFailed = false;
let forecastData = null;

// Initialize WASM
fetch('/routing.wasm')
    .then(response => {
        if (!response.ok) throw new Error("HTTP " + response.status);
        return response.arrayBuffer();
    })
    .then(bytes => WebAssembly.instantiate(bytes, { env: { abort: () => console.log("WASM abort") } }))
    .then(results => {
        wasmMath = results.instance.exports;
        console.log("WASM Module Loaded inside Worker");
    })
    .catch(err => {
        console.error("WASM load failed:", err);
        wasmFailed = true;
    });

function sphericalDistance(lat1, lon1, lat2, lon2) {
    if (wasmMath && wasmMath.sphericalDistance) {
        return wasmMath.sphericalDistance(lat1, lon1, lat2, lon2);
    }
    // Fallback
    const R = 6371e3;
    const p1 = lat1 * Math.PI / 180;
    const p2 = lat2 * Math.PI / 180;
    const dp = (lat2 - lat1) * Math.PI / 180;
    const dl = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dp / 2) * Math.sin(dp / 2) + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

function calculateGridPenalty(hazardCost, currentCost, windPenalty, leewayCrabPenalty, shallowCanalPenalty, weatherPenalty) {
    if (wasmMath && wasmMath.calculateGridPenalty) {
        return wasmMath.calculateGridPenalty(hazardCost, currentCost, windPenalty, leewayCrabPenalty, shallowCanalPenalty, weatherPenalty);
    }
    const penaltyFactor = hazardCost + currentCost + windPenalty + leewayCrabPenalty + shallowCanalPenalty + weatherPenalty;
    return Math.max(0.4, 1 + penaltyFactor);
}

function getConditionsAtETA(etaHours, lat = null, lng = null) {
    if (!forecastData) {
        return { windSpd: 12, windDir: 212, waveHt: 0.5, waveDir: 219, precip: 0, currentSpd: 0.6, currentDir: 252 };
    }
    const w = forecastData.weather || {};
    const mar = forecastData.marine || {};

    let currentUtcIdx = 0;
    if (Array.isArray(w.time)) {
        const nowIsoHour = new Date().toISOString().slice(0, 13);
        const found = w.time.findIndex(t => typeof t === 'string' && t.startsWith(nowIsoHour));
        if (found !== -1) currentUtcIdx = found;
    }

    const windArr = w.wind_direction_10m || w.wind_speed_10m || [];
    const maxLen = Array.isArray(windArr) && windArr.length > 0 ? windArr.length - 1 : 47;
    const validEta = (typeof etaHours === 'number' && !isNaN(etaHours)) ? etaHours : 0;
    const targetIdx = Math.max(0, Math.min(maxLen, currentUtcIdx + Math.floor(validEta)));

    let offsetMult = 1.0;
    if (lat !== null && lng !== null && forecastData.geoPoint) {
        const d = sphericalDistance(lat, lng, forecastData.geoPoint.lat, forecastData.geoPoint.lng);
        if (d > 50000) { offsetMult = 1.0 + (d / 100000) * 0.1; }
    }

    const windSpd = ((Array.isArray(w.wind_speed_10m) && w.wind_speed_10m[targetIdx] !== undefined) ? w.wind_speed_10m[targetIdx] : 12) * offsetMult;
    const windDir = (Array.isArray(w.wind_direction_10m) && w.wind_direction_10m[targetIdx] !== undefined) ? w.wind_direction_10m[targetIdx] : 212;
    const waveHt = ((Array.isArray(mar.wave_height) && mar.wave_height[targetIdx] !== undefined) ? mar.wave_height[targetIdx] : ((Array.isArray(w.wave_height) && w.wave_height[targetIdx] !== undefined) ? w.wave_height[targetIdx] : 0.5)) * offsetMult;
    const waveDir = (Array.isArray(mar.wave_direction) && mar.wave_direction[targetIdx] !== undefined) ? mar.wave_direction[targetIdx] : ((Array.isArray(w.wave_direction) && w.wave_direction[targetIdx] !== undefined) ? w.wave_direction[targetIdx] : 219);
    const precip = (Array.isArray(w.precipitation) && w.precipitation[targetIdx] !== undefined) ? w.precipitation[targetIdx] : 0;
    // Open-Meteo Marine reports ocean_current_velocity in km/h; the planner costs
    // legs in knots. The raw array value is converted, the 0.6 fallback is not --
    // that constant was already written as knots. Same fix as the console's
    // getConditionsAtETA, kept in step with it because the two are differenced
    // against each other by the proactive-reroute check.
    const rawCurrentKmh = (Array.isArray(mar.ocean_current_velocity) && mar.ocean_current_velocity[targetIdx] !== undefined)
        ? mar.ocean_current_velocity[targetIdx]
        : ((Array.isArray(w.ocean_current_velocity) && w.ocean_current_velocity[targetIdx] !== undefined) ? w.ocean_current_velocity[targetIdx] : null);
    const currentSpd = (rawCurrentKmh !== null && isFinite(rawCurrentKmh) ? rawCurrentKmh * 0.539957 : 0.6) * offsetMult;
    const currentDir = (Array.isArray(mar.ocean_current_direction) && mar.ocean_current_direction[targetIdx] !== undefined) ? mar.ocean_current_direction[targetIdx] : ((Array.isArray(w.ocean_current_direction) && w.ocean_current_direction[targetIdx] !== undefined) ? w.ocean_current_direction[targetIdx] : 252);

    return { windSpd, windDir, waveHt, waveDir, precip, currentSpd, currentDir };
}

self.onmessage = function(e) {
    const { grid, w, h, minLat, maxLat, minLng, maxLng, sx, sy, ex, ey, hazardGrid, weatherConditions, distToLand, hydro, forecastDataPayload } = e.data;
    forecastData = forecastDataPayload;
    
    // Ensure WASM is loaded before running
    const waitWasm = () => {
        if (!wasmMath && !wasmFailed) {
            setTimeout(waitWasm, 50);
        } else {
            const path = runAStar(grid, w, h, minLat, maxLat, minLng, maxLng, sx, sy, ex, ey, hazardGrid, weatherConditions, distToLand, hydro);
            self.postMessage({ path });
        }
    };
    waitWasm();
};

function runAStar(grid, w, h, minLat, maxLat, minLng, maxLng, sx, sy, ex, ey, hazardGrid, dynCondInitial, distToLand, hydro) {
    const dLat = (maxLat - minLat) / (h - 1);
    const dLng = (maxLng - minLng) / (w - 1);
    const getLat = (y) => maxLat - y * dLat;
    const getLng = (x) => minLng + x * dLng;
    const endLat = getLat(ey);
    const endLng = getLng(ex);
    
    const size = w * h;
    const costSoFar = new Float32Array(size);
    costSoFar.fill(Infinity);
    const timeSoFar = new Float32Array(size);
    timeSoFar.fill(0);
    const cameFrom = new Int32Array(size);
    cameFrom.fill(-1);
    
    const pq = new PriorityQueue();
    const startIdx = sy * w + sx;
    costSoFar[startIdx] = 0;
    pq.enqueue(startIdx, 0);
    const endIdx = ey * w + ex;
    
    const dirs = [
        {dx: 0, dy: -1, cost: 1}, {dx: 0, dy: 1, cost: 1}, 
        {dx: -1, dy: 0, cost: 1}, {dx: 1, dy: 0, cost: 1},
        {dx: -1, dy: -1, cost: 1.414}, {dx: 1, dy: -1, cost: 1.414}, 
        {dx: -1, dy: 1, cost: 1.414}, {dx: 1, dy: 1, cost: 1.414}
    ];
    
    const visited = new Uint8Array(size);
    let iterations = 0;
    const parentDir = new Int8Array(size); 
    parentDir.fill(-1);
    
    while (!pq.isEmpty()) {
        if (++iterations > 5000000) break;
        const current = pq.dequeue().element;
        if (visited[current]) continue;
        visited[current] = 1;
        if (current === endIdx) { break; }
        
        const cx = current % w;
        const cy = Math.floor(current / w);
        const pDir = parentDir[current];
        
        for (let i = 0; i < dirs.length; i++) {
            const nx = cx + dirs[i].dx;
            const ny = cy + dirs[i].dy;
            
            if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
                const nextIdx = ny * w + nx;
                if (grid[nextIdx] !== 0) continue;
                
                if (dirs[i].dx !== 0 && dirs[i].dy !== 0) {
                    if (grid[cy * w + nx] !== 0 || grid[ny * w + cx] !== 0) { continue; }
                }
                
                const hazardCost = (hazardGrid && hazardGrid[nextIdx] !== undefined) ? hazardGrid[nextIdx] : 0;
                const currLat = getLat(cy);
                const nextLat = getLat(ny);
                const avgLat = (currLat + nextLat) / 2;
                const latDiff = (ny - cy) * dLat;
                const lngDiff = (nx - cx) * dLng;
                const earthDx = lngDiff * Math.cos(avgLat * Math.PI / 180);
                const earthDy = latDiff;
                const moveCost = Math.sqrt(earthDx * earthDx + earthDy * earthDy) / dLat;
                
                const speedKts = (hydro && hydro.serviceSpeedKts) || 15;
                const draft = (hydro && hydro.draft) || 4.5;
                const lbp = (hydro && hydro.lbp) || 100;
                const frontalArea = (hydro && hydro.windageFrontalArea) || 30;
                const lateralArea = (hydro && hydro.windageLateralArea) || 100;
                const cb = (hydro && hydro.cb) || 0.65;

                const distMeters = moveCost * (dLat * 111320);
                const stepTimeSecs = distMeters / (speedKts * 0.51444);
                const nextTime = timeSoFar[current] + stepTimeSecs / 3600;
                
                let dynCond = dynCondInitial;
                if (forecastData) {
                    dynCond = getConditionsAtETA(nextTime, getLat(ny), getLng(nx));
                }
                
                let currentAngle = 0;
                let currentMagnitude = 0;
                if (dynCond && dynCond.currentSpd !== undefined && dynCond.currentSpd > 0) {
                    currentAngle = (dynCond.currentDir - 90) * Math.PI / 180;
                    currentMagnitude = dynCond.currentSpd * 0.05;
                }
                const currentDx = Math.cos(currentAngle);
                const currentDy = Math.sin(currentAngle);
                const moveLength = dirs[i].cost;
                const moveDx = dirs[i].dx / moveLength;
                const moveDy = dirs[i].dy / moveLength;
                const dot = moveDx * currentDx + moveDy * currentDy;
                const currentCost = currentMagnitude > 0 ? -dot * 0.2 * currentMagnitude : 0;
                
                let windPenalty = 0;
                let leewayCrabPenalty = 0;
                if (dynCond && dynCond.windSpd > 0) {
                    const windAngleRad = (dynCond.windDir || 0) * Math.PI / 180;
                    const windDx = Math.sin(windAngleRad);
                    const windDy = -Math.cos(windAngleRad);
                    const windDot = moveDx * windDx + moveDy * windDy;
                    const crossWindDot = Math.abs(moveDx * (-windDy) + moveDy * windDx);
                    windPenalty = (windDot * 0.15 + crossWindDot * 0.1) * (dynCond.windSpd / 20) * (frontalArea / 30);
                    leewayCrabPenalty = crossWindDot * 0.08 * (lateralArea / (lbp * draft));
                }
                
                let shallowCanalPenalty = 0;
                if (distToLand) {
                    const dLand = distToLand[nextIdx];
                    if (dLand !== undefined) {
                        const waterDepthH = (dLand >= 10) ? 50 : Math.max(draft + 0.5, draft * (1 + 0.25 * dLand));
                        const depthFn = (speedKts * 0.51444) / Math.sqrt(9.81 * waterDepthH);
                        const shallowMult = 1.0 + 0.4 * Math.pow(draft / waterDepthH, 2) + (0.3 / Math.max(0.1, Math.pow(1 - Math.min(0.9, depthFn), 2))) - 0.3;
                        shallowCanalPenalty = (shallowMult - 1.0) * 0.8;
                    }
                }
                
                let weatherPenalty = 0;
                if (dynCond && dynCond.waveHt > 1.0) {
                    const waveAngleRad = (dynCond.waveDir || 0) * Math.PI / 180;
                    const waveDx = Math.sin(waveAngleRad);
                    const waveDy = -Math.cos(waveAngleRad);
                    const waveDot = moveDx * waveDx + moveDy * waveDy;
                    weatherPenalty += (dynCond.waveHt * 0.15) * (1.0 + 0.2 * (cb / 0.6));
                }
                
                let turnCost = 0;
                if (pDir !== -1 && pDir !== i) { turnCost = 0.05; }
                
                // Using WASM for Math penalty factor
                const stepMultiplier = calculateGridPenalty(hazardCost, currentCost, windPenalty, leewayCrabPenalty, shallowCanalPenalty, weatherPenalty);
                const newCost = costSoFar[current] + moveCost * stepMultiplier + turnCost;
                
                if (newCost < costSoFar[nextIdx]) {
                    costSoFar[nextIdx] = newCost;
                    timeSoFar[nextIdx] = nextTime;
                    cameFrom[nextIdx] = current;
                    parentDir[nextIdx] = i;
                    
                    // Using WASM for Spherical Distance Math
                    const hCost = (sphericalDistance(nextLat, getLng(nx), endLat, endLng) / (dLat * 111320));
                    pq.enqueue(nextIdx, newCost + hCost);
                }
            }
        }
    }
    
    if (cameFrom[endIdx] === -1) return null;
    const path = [];
    let curr = endIdx;
    while (curr !== -1) {
        path.push({ x: curr % w, y: Math.floor(curr / w) });
        curr = cameFrom[curr];
    }
    return path.reverse();
}
