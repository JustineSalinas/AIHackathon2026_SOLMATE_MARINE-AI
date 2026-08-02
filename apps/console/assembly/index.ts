// Math module in WebAssembly

export function sphericalDistance(lat1: f64, lon1: f64, lat2: f64, lon2: f64): f64 {
    const R: f64 = 6371e3;
    const PI: f64 = 3.141592653589793;
    const p1: f64 = lat1 * PI / 180.0;
    const p2: f64 = lat2 * PI / 180.0;
    const dp: f64 = (lat2 - lat1) * PI / 180.0;
    const dl: f64 = (lon2 - lon1) * PI / 180.0;
    
    const a: f64 = Math.sin(dp / 2.0) * Math.sin(dp / 2.0) +
                   Math.cos(p1) * Math.cos(p2) *
                   Math.sin(dl / 2.0) * Math.sin(dl / 2.0);
                   
    const c: f64 = 2.0 * Math.atan2(Math.sqrt(a), Math.sqrt(1.0 - a));
    return R * c;
}

export function calculateGridPenalty(
    hazardCost: f64, 
    currentCost: f64, 
    windPenalty: f64, 
    leewayCrabPenalty: f64, 
    shallowCanalPenalty: f64, 
    weatherPenalty: f64
): f64 {
    const penaltyFactor: f64 = hazardCost + currentCost + windPenalty + leewayCrabPenalty + shallowCanalPenalty + weatherPenalty;
    return Math.max(0.4, 1.0 + penaltyFactor);
}
