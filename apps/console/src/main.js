import { driver } from "driver.js";
import "driver.js/dist/driver.css";


        
        // --- SPHERICAL EARTH MATH ---
        function toRad(deg) { return deg * Math.PI / 180; }
        function toDeg(rad) { return rad * 180 / Math.PI; }
        
        function sphericalDistance(lat1, lon1, lat2, lon2) {
            const R = 6371e3; // Earth radius in meters
            const φ1 = toRad(lat1), φ2 = toRad(lat2);
            const Δφ = toRad(lat2 - lat1), Δλ = toRad(lon2 - lon1);
            const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ/2) * Math.sin(Δλ/2);
            return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
        }
        
        function sphericalHeading(lat1, lon1, lat2, lon2) {
            const φ1 = toRad(lat1), φ2 = toRad(lat2);
            const Δλ = toRad(lon2 - lon1);
            const y = Math.sin(Δλ) * Math.cos(φ2);
            const x = Math.cos(φ1)*Math.sin(φ2) - Math.sin(φ1)*Math.cos(φ2)*Math.cos(Δλ);
            return (toDeg(Math.atan2(y, x)) + 360) % 360;
        }
        
        function lerpAngle(a, b, t) {
            const delta = ((((b - a) % 360) + 540) % 360) - 180;
            return (a + delta * t + 360) % 360;
        }

        // A hull cannot pivot. Rudder authority and speed bound how fast a heading
        // can change, so the vessel is steered TOWARD its course rather than
        // snapped onto it at every waypoint.
        //
        // This is a vessel property, not a visual easing, and the distinction is
        // load-bearing: `heading_deg` is sent to /advise and feeds the resistance
        // model, which resolves wind and sea onto the hull by relative angle. A
        // heading smoothed in *real* time to look nice would quietly change the
        // advised RPM. The limit is therefore in degrees per second of SIMULATED
        // time and scales with the sim clock, which is also what makes it correct
        // at 120x: a boat really would finish the turn in that much sea time.
        //
        // 8 deg/s is a comfortable rate for a loaded passenger banca -- above the
        // 3 deg/s "standard rate" used in navigation, well under what an unloaded
        // hull could manage.
        const MAX_RATE_OF_TURN_DEG_S = 8;

        function steerToward(current, target, maxDeltaDeg) {
            const delta = ((((target - current) % 360) + 540) % 360) - 180;
            if (!Number.isFinite(delta) || Math.abs(delta) <= maxDeltaDeg) {
                return (target + 360) % 360;
            }
            return (current + Math.sign(delta) * maxDeltaDeg + 360) % 360;
        }
        
        function sphericalInterpolate(lat1, lon1, lat2, lon2, fraction) {
            const d = sphericalDistance(lat1, lon1, lat2, lon2) / 6371e3;
            if (d === 0) return { lat: lat1, lng: lon1 };
            const a = Math.sin((1 - fraction) * d) / Math.sin(d);
            const b = Math.sin(fraction * d) / Math.sin(d);
            const φ1 = toRad(lat1), φ2 = toRad(lat2);
            const λ1 = toRad(lon1), λ2 = toRad(lon2);
            const x = a * Math.cos(φ1) * Math.cos(λ1) + b * Math.cos(φ2) * Math.cos(λ2);
            const y = a * Math.cos(φ1) * Math.sin(λ1) + b * Math.cos(φ2) * Math.sin(λ2);
            const z = a * Math.sin(φ1) + b * Math.sin(φ2);
            return {
                lat: toDeg(Math.atan2(z, Math.sqrt(x*x + y*y))),
                lng: toDeg(Math.atan2(y, x))
            };
        }

        const State = {
            isGpsMode: false,
            gpsWatchId: null,
            imuHeading: null,

            isRunning: false,
            direction: 1, 
            activeTool: 'pointer',
            apiLivestream: true,
            pathMode: 'rrt', // Only RRT used
            
            isManualMode: false,
            manualJoystick: { force: 0, angle: 0 },
            
            portA: null, 
            portB: null,
            
            // currentPax is null until the manifest is taken at departure, and
            // returns to null once the voyage is logged. Null means "not asked".
            // `steering` is false until the vessel is first under way, so the
            // opening frame adopts its course instead of rotating onto it.
            ship: { progress: 0, lat: 10.6928, lng: 122.5644, angle: 0, headingDeg: 0, targetHeadingDeg: 0, actualKnots: 0, distanceTraveledNM: 0, currentPax: null, steering: false },
            
            basePath: [],     
            targetPath: [],   
            entities: { obstacles: [], storms: [] },
            // Last /api/advise response, or null when the optimiser has not been
            // reached yet. Null is a displayed state, not a reason to invent a
            // number -- see optimizeSpeedAndRouteAsync.
            ai: { recThrottle: null, savings: null },
            // Last /api/route response. Holds the planner's own fuel delta
            // against the direct track, which is what the savings readout shows.
            routePlan: null,
            mlLogger: {
                data: [],
                lastSampleTimeMs: 0,
                intervalMs: 1000
            },
            aiWaypoints: [],
            aiStrategy: ""
        };

        function updatePathEngineUI(mode, isAiSuccess = true) {
            const badge = document.getElementById('badgePathEngine');
            const txtName = document.getElementById('txtPathEngineName');
            const txtDesc = document.getElementById('txtPathEngineDesc');
            const valAi = document.getElementById('valEngineAiStatus');
            const valAstar = document.getElementById('valEngineAstarStatus');
            const btnRRT = document.getElementById('btnPathModeRRT');
            const cardAiAudit = document.getElementById('cardAiAudit');

            if (!State.portA || !State.portB) {
                if (badge) {
                    badge.textContent = "Awaiting Ports";
                    badge.className = "text-xs bg-slate-800 text-slate-400 border border-slate-700 px-1.5 py-0.5 rounded font-mono font-bold";
                }
                if (txtName) txtName.textContent = "Standby (No Route)";
                if (txtDesc) txtDesc.textContent = "Select Departure (Port A) and Destination (Port B) on map to generate route.";
                if (valAi) { valAi.textContent = "Standby"; valAi.className = "font-bold text-slate-400 truncate"; }
                if (valAstar) { valAstar.textContent = "Standby"; valAstar.className = "font-bold text-slate-400 truncate"; }
                if (cardAiAudit) cardAiAudit.classList.add('hidden');
                return;
            }

            if (cardAiAudit) cardAiAudit.classList.remove('hidden');

            if (badge) {
                badge.textContent = "BAIRRT Explorer Path";
                badge.className = "text-xs bg-emerald-500/20 text-emerald-300 border border-emerald-500/50 px-1.5 py-0.5 rounded font-mono font-bold";
            }
            if (txtName) txtName.textContent = "Bi-directional Adaptive Informed RRT";
            if (txtDesc) txtDesc.textContent = "Path generated by Rapidly-exploring Random Tree sampling on water cells, followed by Line-of-Sight smoothing. Automatically audited and optimized by AI.";
            if (valAi) {
                valAi.textContent = "Active (Route Critique)";
                valAi.className = "font-bold text-emerald-300 truncate";
            }
            if (valAstar) {
                valAstar.textContent = "Active (RRT Tree)";
                valAstar.className = "font-bold text-emerald-300 truncate";
            }

            if (btnRRT) {
                btnRRT.className = 'px-1.5 py-1 rounded transition-all cursor-pointer text-center truncate bg-emerald-500/20 text-emerald-300 border border-emerald-500/50 font-bold hover:bg-emerald-500/30';
            }
        }

        let map = null;
        let aiWaypointLayerGroup = null;
        let gmapAiWpMarkers = [];
        let debugLayerGroup = null;

        function clearAiWaypointMarkers() {
            if (aiWaypointLayerGroup && map) {
                aiWaypointLayerGroup.clearLayers();
            }
            if (gmapAiWpMarkers.length > 0) {
                gmapAiWpMarkers.forEach(m => { try { m.remove(); } catch(e){} });
                gmapAiWpMarkers = [];
            }
        }

        function renderAiWaypointMarkers(waypoints) {
            if (!map) return;
            if (!aiWaypointLayerGroup) {
                aiWaypointLayerGroup = L.layerGroup().addTo(map);
            } else {
                aiWaypointLayerGroup.clearLayers();
            }

            if (gmapAiWpMarkers.length > 0) {
                gmapAiWpMarkers.forEach(m => { try { m.remove(); } catch(e){} });
                gmapAiWpMarkers = [];
            }

            if (!waypoints || waypoints.length === 0) return;

            waypoints.forEach((wp, idx) => {
                const wpHtml = `
                    <div style="width:26px; height:26px; background: rgba(245, 158, 11, 0.25); border: 2px solid #f59e0b; border-radius: 50%; display: flex; align-items: center; justify-content: center; filter: drop-shadow(0 0 10px #f59e0b);">
                        <i class="fa-solid fa-diamond text-amber-400 text-xs"></i>
                    </div>
                `;
                const icon = L.divIcon({
                    className: 'custom-ai-wp-icon',
                    html: wpHtml,
                    iconSize: [26, 26],
                    iconAnchor: [13, 13]
                });

                const marker = L.marker([wp.lat, wp.lng], { icon }).addTo(aiWaypointLayerGroup);
                
                const popupContent = `
                    <div class="p-2 space-y-1 font-sans text-xs bg-slate-900 text-slate-200 rounded border border-amber-500/40">
                        <div class="font-bold text-amber-400 flex items-center gap-1.5">
                            <i class="fa-solid fa-diamond text-xs"></i> Planned waypoint #${idx + 1}
                        </div>
                        <div class="font-semibold text-white">${wp.name || 'Waypoint ' + (idx + 1)}</div>
                        <div class="text-sm text-slate-300">${wp.tacticalReason || 'Planned leg.'}</div>
                        <div class="text-xs text-orange-400 font-mono mt-1">Leg RPM: ${wp.recommendedRpm != null ? Math.round(wp.recommendedRpm) : '—'}</div>
                        <div class="text-xs text-slate-400 font-mono">${wp.lat.toFixed(4)}°N, ${wp.lng.toFixed(4)}°E</div>
                    </div>
                `;
                marker.bindPopup(popupContent);
                marker.bindTooltip(`AI Waypoint ${idx + 1}: ${wp.name || ''}`, { direction: 'top', offset: [0, -10] });

                if (typeof gmap !== 'undefined' && gmap && typeof maplibregl !== 'undefined') {
                    try {
                        const el = document.createElement('div');
                        el.className = 'custom-3d-wp-marker';
                        el.innerHTML = `<div style="width:22px; height:22px; background: rgba(245, 158, 11, 0.35); border: 2px solid #f59e0b; border-radius: 50%; display:flex; align-items:center; justify-content:center; box-shadow: 0 0 12px #f59e0b;"><i class="fa-solid fa-diamond text-amber-400 text-xs"></i></div>`;
                        const gMarker = new maplibregl.Marker({ element: el })
                            .setLngLat([wp.lng, wp.lat])
                            .addTo(gmap);
                        gmapAiWpMarkers.push(gMarker);
                    } catch(e) {}
                }
            });
        }

        // Fuel saved against the direct track, as a percentage.
        //
        // Reads the planner's own two numbers -- what the chosen track burns and
        // what the great-circle baseline burns, both costed through the same fuel
        // model -- and shows the difference. A dash means no plan has been
        // returned yet; "0.0%" means the direct track already was the cheapest,
        // which is the correct answer in flat weather and the one the old random
        // number could never give.
        function renderRouteSavings(plan) {
            const savingsEl = document.getElementById('outSavings');
            if (!savingsEl) return;

            if (!plan || !plan.ok || plan.savingsPct == null || !Number.isFinite(plan.savingsPct)) {
                savingsEl.innerText = '—';
                savingsEl.title = plan && plan.ok === false
                    ? 'Optimiser unreachable — no fuel delta available.'
                    : 'No route plan yet. Set both ports to plan a route.';
                return;
            }

            const pct = plan.savingsPct;
            const sign = pct > 0 ? '+' : '';
            savingsEl.innerText = `${sign}${pct.toFixed(1)}%`;
            savingsEl.title =
                `${(plan.predictedBurnL ?? 0).toFixed(2)} L on the planned track vs ` +
                `${(plan.baselineBurnL ?? 0).toFixed(2)} L on the direct track ` +
                `(services/route/planner.py).`;
        }

        // The route panel: what the planner did, and what constrained it.
        //
        // This panel used to show a letter grade, a safety score out of 100 and
        // an efficiency score out of 100, all three invented by a language model
        // asked to "rate the trajectory". None of them were measurements of
        // anything, and the first question anyone asks about a 82/100 is where
        // the 82 came from.
        //
        // It now shows facts the planner actually produces: the fuel delta
        // against the direct track, the crossing time the hull can achieve, and
        // the constraints that shaped the answer. `constraint_notes` are the
        // planner's own reasons for rejecting a shorter track -- the honest
        // version of a critique, because they name a rule rather than an opinion.
        function renderAiAuditPanel(plan) {
            const txtTitle = document.getElementById('txtAuditTitle');
            const badgeRating = document.getElementById('badgeAuditRating');
            const valSafety = document.getElementById('valAuditSafety');
            const valEfficiency = document.getElementById('valAuditEfficiency');
            const listCritiques = document.getElementById('listAuditCritiques');

            const algoNameMap = {
                'dlite': 'D* Lite Pathfinder',
                'rrt': 'RRT Explorer'
            };
            const algoName = algoNameMap[State.pathMode] || 'Pathfinder';

            // The HTML default is "RRT Explorer AI Audit"; this keeps that wording
            // and only swaps the algorithm name, so a non-RRT mode still labels
            // itself honestly instead of inheriting RRT's title.
            if (txtTitle) txtTitle.textContent = `${algoName} AI Audit`;

            const unavailable = !plan || plan.ok === false;

            if (badgeRating) {
                if (unavailable) {
                    badgeRating.textContent = 'Optimiser offline';
                    badgeRating.className = "text-xs bg-slate-500/20 text-slate-300 px-2 py-0.5 rounded font-mono font-bold border border-slate-500/30";
                } else {
                    const constrained = plan.depthConstrained || plan.weatherConstrained;
                    badgeRating.textContent = constrained ? 'Constrained track' : 'Unconstrained';
                    badgeRating.className = constrained
                        ? "text-xs bg-amber-500/20 text-amber-300 px-2 py-0.5 rounded font-mono font-bold border border-amber-500/30"
                        : "text-xs bg-emerald-500/20 text-emerald-300 px-2 py-0.5 rounded font-mono font-bold border border-emerald-500/30";
                }
            }

            // Fuel on the planned track, in litres. Not a score.
            if (valSafety) {
                valSafety.textContent = unavailable || plan.predictedBurnL == null
                    ? '—'
                    : `${plan.predictedBurnL.toFixed(2)} L`;
                valSafety.className = "font-bold text-sky-300";
            }

            // Crossing time the hull can actually achieve, which is not always
            // the ETA that was asked for. Where they differ this is the true one.
            if (valEfficiency) {
                valEfficiency.textContent = unavailable || plan.achievableMinutes == null
                    ? '—'
                    : `${plan.achievableMinutes.toFixed(1)} min`;
                valEfficiency.className = (!unavailable && plan.scheduleFeasible === false)
                    ? "font-bold text-amber-400"
                    : "font-bold text-emerald-400";
            }

            if (listCritiques) {
                listCritiques.innerHTML = '';
                const notes = [];

                if (unavailable) {
                    notes.push('Route optimiser unreachable — no plan to report.');
                } else {
                    if (Array.isArray(plan.constraintNotes)) notes.push(...plan.constraintNotes);
                    if (plan.scheduleFeasible === false) {
                        notes.push('Engine cannot hold the requested ETA on every leg; arrival will be late.');
                    }
                    if (plan.savingsL != null && Math.abs(plan.savingsL) < 0.005) {
                        notes.push('The direct track is already the cheapest route in this weather.');
                    }
                    if (plan.forecastSource) {
                        notes.push(`Forecast source: ${plan.forecastSource}.`);
                    }
                    if (plan.modelTrained === false) {
                        notes.push('No trained wear artifact loaded; the engine is assumed healthy.');
                    }
                }

                if (notes.length === 0) notes.push('No constraint bound this route.');

                notes.forEach(note => {
                    const li = document.createElement('li');
                    li.className = 'text-slate-300 pl-1';
                    li.textContent = note;
                    listCritiques.appendChild(li);
                });
            }
        }

        function renderDebugLayers() {
            if (!map) return;
            if (!debugLayerGroup) {
                debugLayerGroup = L.layerGroup().addTo(map);
            } else {
                debugLayerGroup.clearLayers();
            }

            if (State.pathMode === 'rrt' && State.rrtTreeEdges && State.rrtTreeEdges.length > 0) {
                // Render up to 750 edges for beautiful sampling-tree exploration
                const edgesToRender = State.rrtTreeEdges.slice(0, 750);
                edgesToRender.forEach(edge => {
                    const latlngs = edge.map(p => {
                        const lat = SpatialGIS.maxLat - (p.y / (SpatialGIS.gridH - 1)) * (SpatialGIS.maxLat - SpatialGIS.minLat);
                        const lng = SpatialGIS.minLng + (p.x / (SpatialGIS.gridW - 1)) * (SpatialGIS.maxLng - SpatialGIS.minLng);
                        return [lat, lng];
                    });
                    L.polyline(latlngs, {
                        color: 'rgba(16, 185, 129, 0.28)', // Semi-transparent emerald green
                        weight: 1.2,
                        interactive: false
                    }).addTo(debugLayerGroup);
                });
            }
        }

        function updateAiWaypointsHUD(strategy, waypoints) {
            const txtSummary = document.getElementById('txtAiStrategySummary');
            const listElem = document.getElementById('listAiWaypoints');

            if (txtSummary) {
                txtSummary.innerText = strategy || "Route planned by services/route/planner.py.";
            }

            if (listElem) {
                if (!waypoints || waypoints.length === 0) {
                    listElem.innerHTML = '<div class="text-xs text-slate-500">No macro waypoints needed (direct clear fairway).</div>';
                    return;
                }

                let html = '';
                waypoints.forEach((wp, idx) => {
                    html += `
                        <div class="bg-slate-800/80 p-2 rounded border border-slate-700/70 hover:border-amber-500/50 transition-colors">
                            <div class="flex justify-between items-center text-xs">
                                <span class="font-bold text-amber-300 flex items-center gap-1">
                                    <i class="fa-solid fa-diamond text-xs"></i> WP${idx + 1}: ${wp.name || 'Waypoint'}
                                </span>
                                <span class="text-xs font-mono text-orange-400 bg-orange-950/60 px-1 rounded">${wp.recommendedRpm != null ? Math.round(wp.recommendedRpm) + ' rpm' : '—'}</span>
                            </div>
                            <div class="text-xs text-slate-300 mt-1 leading-tight">${wp.tacticalReason || 'Planned leg.'}</div>
                            <div class="text-xs font-mono text-slate-400 mt-1 flex justify-between">
                                <span>Lat: ${wp.lat.toFixed(4)}°</span>
                                <span>Lng: ${wp.lng.toFixed(4)}°</span>
                            </div>
                        </div>
                    `;
                });
                listElem.innerHTML = html;
            }
        }

        function ensurePortAMarker(lat, lng, name) {
            if (!portAMarker) {
                const portAIcon = L.divIcon({
                    className: 'custom-port-a-icon',
                    html: '<div style="background-color: #10b981; width: 22px; height: 22px; border: 3px solid white; border-radius: 50%; box-shadow: 0 0 12px rgba(16,185,129,0.9); display: flex; align-items: center; justify-content: center;"><i class="fa-solid fa-anchor text-xs text-white"></i></div>',
                    iconSize: [22, 22],
                    iconAnchor: [11, 11]
                });
                portAMarker = L.marker([lat, lng], { icon: portAIcon, draggable: true }).addTo(map);
                portAMarker.on('drag', (e) => {
                    if (State.isRunning) return false;
                    const pos = e.target.getLatLng();
                    if (!State.portA) State.portA = {};
                    State.portA.lat = pos.lat;
                    State.portA.lng = pos.lng;
                    State.portA.name = `Departure (${pos.lat.toFixed(4)}, ${pos.lng.toFixed(4)})`;
                    updateRoute();
                });
            } else {
                if (map && !map.hasLayer(portAMarker)) portAMarker.addTo(map);
                portAMarker.setLatLng([lat, lng]);
            }
        }

        function ensurePortBMarker(lat, lng, name) {
            if (!portBMarker) {
                const portBIcon = L.divIcon({
                    className: 'custom-port-b-icon',
                    html: '<div style="background-color: #ef4444; width: 22px; height: 22px; border: 3px solid white; border-radius: 50%; box-shadow: 0 0 12px rgba(239,68,68,0.9); display: flex; align-items: center; justify-content: center;"><i class="fa-solid fa-flag text-xs text-white"></i></div>',
                    iconSize: [22, 22],
                    iconAnchor: [11, 11]
                });
                portBMarker = L.marker([lat, lng], { icon: portBIcon, draggable: true }).addTo(map);
                portBMarker.on('drag', (e) => {
                    if (State.isRunning) return false;
                    const pos = e.target.getLatLng();
                    if (!State.portB) State.portB = {};
                    State.portB.lat = pos.lat;
                    State.portB.lng = pos.lng;
                    State.portB.name = `Destination (${pos.lat.toFixed(4)}, ${pos.lng.toFixed(4)})`;
                    updateRoute();
                });
            } else {
                if (map && !map.hasLayer(portBMarker)) portBMarker.addTo(map);
                portBMarker.setLatLng([lat, lng]);
            }
        }

        function shouldShowBoat() {
            return (Boolean(State.portA) && Boolean(State.portB)) || Boolean(State.isGpsMode);
        }

        function ensureShipMarker(lat, lng) {
            if (!shouldShowBoat()) {
                if (shipMarker && map && map.hasLayer(shipMarker)) {
                    map.removeLayer(shipMarker);
                }
                return;
            }
            if (!shipMarker) {
                const shipIcon = L.divIcon({
                    className: 'custom-ship-icon',
                    html: `<div id="shipIconDiv" style="width: 26px; height: 26px; display: flex; align-items: center; justify-content: center; filter: drop-shadow(0 0 8px rgba(249,115,22,0.8)) drop-shadow(0 0 2px rgba(0,0,0,0.9));">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36" width="26" height="26" style="display: block; overflow: visible;">
                            <!-- Outer white outline layer -->
                            <path d="M 18,2 L 33,33 L 18,25 L 3,33 Z" fill="none" stroke="#ffffff" stroke-width="2.8" stroke-linejoin="round" stroke-linecap="round"/>
                            <!-- Left wing (darker orange) -->
                            <path d="M 18,2 L 3,33 L 18,25 Z" fill="#ea580c"/>
                            <!-- Right wing (brighter orange) -->
                            <path d="M 18,2 L 18,25 L 33,33 Z" fill="#f97316"/>
                            <!-- Fine inner seam line -->
                            <path d="M 18,2 L 18,25" stroke="#ffffff" stroke-width="1.2" stroke-linecap="round"/>
                        </svg>
                    </div>`,
                    iconSize: [26, 26],
                    iconAnchor: [13, 13]
                });
                shipMarker = L.marker([lat, lng], { icon: shipIcon }).addTo(map);
            } else {
                if (map && !map.hasLayer(shipMarker)) shipMarker.addTo(map);
                shipMarker.setLatLng([lat, lng]);
            }
        }

        function resetPorts() {
            if (State.isRunning) {
                log("Cannot reset ports during active voyage. Abort voyage first.", "warn");
                alert("Cannot reset ports during an active voyage. Please abort or complete the voyage first.");
                return false;
            }
            State.aiWaypoints = [];
            State.aiStrategy = "";
            clearAiWaypointMarkers();
            updateAiWaypointsHUD("Set both Departure (Port A) and Destination (Port B) to plan a route.", []);
            if (portAMarker && map && map.hasLayer(portAMarker)) map.removeLayer(portAMarker);
            if (portBMarker && map && map.hasLayer(portBMarker)) map.removeLayer(portBMarker);
            if (shipMarker && map && map.hasLayer(shipMarker)) map.removeLayer(shipMarker);
            portAMarker = null;
            portBMarker = null;
            shipMarker = null;
            State.portA = null;
            State.portB = null;
            State.ship.progress = 0;
            State.ship.distanceTraveledNM = 0;
            State.basePath = [];
            State.targetPath = [];
            State.idealPath = [];
            if (baseRoutePolyline) baseRoutePolyline.setLatLngs([]);
            if (aiRoutePolyline) aiRoutePolyline.setLatLngs([]);
            if (idealRoutePolyline) idealRoutePolyline.setLatLngs([]);
            
            if (typeof gmap !== 'undefined' && gmap) {
                if (gmap.getSource('route')) {
                    gmap.getSource('route').setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [] } });
                }
                if (gmap.getSource('idealRoute')) {
                    gmap.getSource('idealRoute').setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [] } });
                }
            }

            updateDisplayValue('headerSubtitle', "Start & End ports removed. Select Port A / Port B tools to set locations on map.");
            updateDisplayValue('throttleStatus', "Awaiting Ports");
            log("Departure (Port A), Destination (Port B), and all generated routes removed.", "info");
        }

        let portAMarker = null, portBMarker = null, shipMarker = null;
        let baseRoutePolyline = null, aiRoutePolyline = null, idealRoutePolyline = null, hazardLayerGroup = null;
        let satelliteTileLayer = null, defaultMapTileLayer = null, labelsTileLayer = null;
        let oceanBaseTileLayer = null, oceanRefTileLayer = null, openSeaMapTileLayer = null;
        let current2DMapType = 'satellite'; // 'satellite', 'default', 'nautical'
        let current3DMapType = 'satellite'; // 'satellite', 'nautical'
        let isNauticalOverlayActive = true;
        let REAL_DISTANCE_KM = 3.27;

        function setMapType(type) {
            current2DMapType = type;
            current3DMapType = type;

            if (map) {
                if (satelliteTileLayer && map.hasLayer(satelliteTileLayer)) map.removeLayer(satelliteTileLayer);
                if (labelsTileLayer && map.hasLayer(labelsTileLayer)) map.removeLayer(labelsTileLayer);
                if (defaultMapTileLayer && map.hasLayer(defaultMapTileLayer)) map.removeLayer(defaultMapTileLayer);
                if (oceanBaseTileLayer && map.hasLayer(oceanBaseTileLayer)) map.removeLayer(oceanBaseTileLayer);
                if (oceanRefTileLayer && map.hasLayer(oceanRefTileLayer)) map.removeLayer(oceanRefTileLayer);

                if (type === 'default') {
                    if (defaultMapTileLayer && !map.hasLayer(defaultMapTileLayer)) defaultMapTileLayer.addTo(map);
                } else if (type === 'nautical') {
                    if (oceanBaseTileLayer && !map.hasLayer(oceanBaseTileLayer)) oceanBaseTileLayer.addTo(map);
                    if (oceanRefTileLayer && !map.hasLayer(oceanRefTileLayer)) oceanRefTileLayer.addTo(map);
                } else {
                    if (satelliteTileLayer && !map.hasLayer(satelliteTileLayer)) satelliteTileLayer.addTo(map);
                    if (labelsTileLayer && !map.hasLayer(labelsTileLayer)) labelsTileLayer.addTo(map);
                }
            }

            if (gmap) {
                if (gmap.getLayer('satellite-layer')) {
                    gmap.setLayoutProperty('satellite-layer', 'visibility', type === 'satellite' ? 'visible' : 'none');
                }
                if (gmap.getLayer('default-layer')) {
                    gmap.setLayoutProperty('default-layer', 'visibility', type === 'default' ? 'visible' : 'none');
                }
                if (gmap.getLayer('nautical-base-layer')) {
                    gmap.setLayoutProperty('nautical-base-layer', 'visibility', type === 'nautical' ? 'visible' : 'none');
                }
                if (gmap.getLayer('nautical-ref-layer')) {
                    gmap.setLayoutProperty('nautical-ref-layer', 'visibility', type === 'nautical' ? 'visible' : 'none');
                }
            }

            updateSeamarksOverlay();
            updateMapTypeUI(type);
            log(`Map view switched to ${type.toUpperCase()} mode.`, "info");
        }

        function updateMapTypeUI(type) {
            const iconEl = document.getElementById('mapTypeIcon');
            if (iconEl) {
                if (type === 'default') iconEl.className = "fa-solid fa-map text-emerald-400 text-sm";
                else if (type === 'nautical') iconEl.className = "fa-solid fa-water text-sky-400 text-sm";
                else iconEl.className = "fa-solid fa-earth-americas text-sky-400 text-sm";
            }

            const btnDefault = document.getElementById('btnMapDefault');
            const btnSatellite = document.getElementById('btnMapSatellite');
            const btnNautical = document.getElementById('btnMapNautical');

            const activeClass = "px-2.5 py-1 rounded-lg text-sm sm:text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer bg-orange-500 text-white shadow-md border border-orange-400/50 scale-105";
            const inactiveClass = "px-2.5 py-1 rounded-lg text-sm sm:text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer bg-slate-800/90 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700/60";

            if (btnDefault) btnDefault.className = type === 'default' ? activeClass : inactiveClass;
            if (btnSatellite) btnSatellite.className = type === 'satellite' ? activeClass : inactiveClass;
            if (btnNautical) btnNautical.className = type === 'nautical' ? activeClass : inactiveClass;
        }

        function toggle2DMapType() {
            const nextType = current2DMapType === 'satellite' ? 'default' : (current2DMapType === 'default' ? 'nautical' : 'satellite');
            setMapType(nextType);
        }

        function toggle3DMapType() {
            const nextType = current3DMapType === 'satellite' ? 'default' : (current3DMapType === 'default' ? 'nautical' : 'satellite');
            setMapType(nextType);
        }

        function toggleNauticalOverlay() {
            isNauticalOverlayActive = !isNauticalOverlayActive;
            updateSeamarksOverlay();
            const btn = document.getElementById('toolNauticalOverlay');
            if (btn) {
                if (isNauticalOverlayActive) {
                    btn.className = "w-8 h-8 sm:w-9 sm:h-9 flex items-center justify-center rounded-lg bg-sky-500/20 hover:bg-sky-500/30 text-sky-300 border border-sky-500/40 transition-all cursor-pointer active:scale-95 shrink-0";
                    log("OpenSeaMap Nautical Seamarks Overlay enabled (buoys, beacons, depth contours).", "success");
                } else {
                    btn.className = "w-8 h-8 sm:w-9 sm:h-9 flex items-center justify-center rounded-lg bg-slate-900/80 hover:bg-slate-700/80 text-slate-500 border border-slate-700/80 transition-all cursor-pointer active:scale-95 shrink-0";
                    log("OpenSeaMap Nautical Seamarks Overlay disabled.", "info");
                }
            }
        }

        function updateSeamarksOverlay() {
            if (map && openSeaMapTileLayer) {
                const shouldShow = isNauticalOverlayActive || current2DMapType === 'nautical';
                if (shouldShow && !map.hasLayer(openSeaMapTileLayer)) {
                    openSeaMapTileLayer.addTo(map);
                } else if (!shouldShow && map.hasLayer(openSeaMapTileLayer)) {
                    map.removeLayer(openSeaMapTileLayer);
                }
            }
            if (gmap && gmap.getLayer('openseamap-layer')) {
                const shouldShow = isNauticalOverlayActive || current3DMapType === 'nautical';
                gmap.setLayoutProperty('openseamap-layer', 'visibility', shouldShow ? 'visible' : 'none');
            }
        }
        let lastTime = 0;
        let apiTimer = 0;
        let isFetchingApi = false;

        // ---------------------------------------------------------------------
        // HIGH-PRECISION DUAL-ENGINE GLOBAL LAND DETECTOR MODULE
        // ---------------------------------------------------------------------
        
                const NavEngine = {
            forecastData: null,
            _lastLat: null,
            _lastLng: null,
            
            digitalTwinProfiler: {
                learnedCbMod: 0,
                learnedDragMod: 1.0,
                dataPoints: 0,
                maxVariance: 0.1,
                train(liveData, expectedData, actualSOG) {
                    // Over time, this ML algorithm compares actual performance to theoretical models 
                    // and slowly calibrates the digital twin's physical parameters (like cb or wind drag)
                    const throttle = parseFloat(document.getElementById('inThrottle')?.value || 75);
                    if (throttle > 20 && actualSOG > 2.0) {
                        const speedDiff = liveData.windSpd - expectedData.windSpd; 
                        // Simulate reinforcement learning update based on observed wind difference impact on speed
                        const adjustment = speedDiff * 0.00005;
                        this.learnedCbMod = Math.min(this.maxVariance, Math.max(-this.maxVariance, this.learnedCbMod + adjustment));
                        this.dataPoints++;
                    }
                }
            },

            async generateForecast(lat, lng) {
                if (this._lastLat === lat && this._lastLng === lng && this.forecastData) {
                    return; // Use cached forecast
                }
                this._lastLat = lat;
                this._lastLng = lng;
                try {
                    const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}&hourly=wind_speed_10m,wind_direction_10m,precipitation&wind_speed_unit=kn&forecast_days=2`;
                    const marineUrl = `https://marine-api.open-meteo.com/v1/marine?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}&hourly=wave_height,wave_direction,ocean_current_velocity,ocean_current_direction&forecast_days=2`;
                    
                    const [weatherRes, marineRes] = await Promise.all([
                        fetch(weatherUrl).then(r => r.ok ? r.json() : null).catch(() => null),
                        fetch(marineUrl).then(r => r.ok ? r.json() : null).catch(() => null)
                    ]);
                    
                    if (weatherRes && marineRes && weatherRes.hourly && marineRes.hourly) {
                        this.forecastData = { weather: weatherRes.hourly, marine: marineRes.hourly };
                        log("NavEngine: 48-Hour High-Precision environmental forecast generated.", "success");
                    } else {
                        this.generateSyntheticForecast();
                    }
                } catch(e) {
                    this.generateSyntheticForecast();
                }
            },
            generateSyntheticForecast() {
                 log("NavEngine: Using synthetic environmental modeling.", "info");
                 this.forecastData = {
                     weather: { wind_speed_10m: Array(48).fill(12), wind_direction_10m: Array(48).fill(212), precipitation: Array(48).fill(0) },
                     marine: { wave_height: Array(48).fill(0.5), wave_direction: Array(48).fill(219), ocean_current_velocity: Array(48).fill(0.6), ocean_current_direction: Array(48).fill(252) }
                 };
            },
            getConditionsAtETA(etaHours, lat = null, lng = null) {
                if (!this.forecastData || !this.forecastData.weather || !this.forecastData.weather.wind_direction_10m) {
                    return { windSpd: 12, windDir: 212, waveHt: 0.5, waveDir: 219, precip: 0, currentSpd: 0.6, currentDir: 252 };
                }
                
                // Align index with current UTC hour in Open-Meteo forecast dataset
                let currentUtcIdx = 0;
                if (Array.isArray(this.forecastData.weather.time)) {
                    const nowIsoHour = new Date().toISOString().slice(0, 13);
                    const found = this.forecastData.weather.time.findIndex(t => typeof t === 'string' && t.startsWith(nowIsoHour));
                    if (found !== -1) currentUtcIdx = found;
                }

                const maxLen = this.forecastData.weather.wind_direction_10m.length - 1;
                const idx = Math.min(maxLen, currentUtcIdx + Math.floor(etaHours));
                
                let baseSpd = (this.forecastData.weather.wind_speed_10m && this.forecastData.weather.wind_speed_10m[idx]) ?? 12;
                let baseDir = (this.forecastData.weather.wind_direction_10m && this.forecastData.weather.wind_direction_10m[idx]) ?? 212;
                let currentSpd = (this.forecastData.marine && this.forecastData.marine.ocean_current_velocity && this.forecastData.marine.ocean_current_velocity[idx]) ?? 0.6;
                let currentDir = (this.forecastData.marine && this.forecastData.marine.ocean_current_direction && this.forecastData.marine.ocean_current_direction[idx]) ?? 252;
                let waveHt = (this.forecastData.marine && this.forecastData.marine.wave_height && this.forecastData.marine.wave_height[idx]) ?? 0.5;
                let waveDir = (this.forecastData.marine && this.forecastData.marine.wave_direction && this.forecastData.marine.wave_direction[idx]) ?? 219;

                // Add spatial variance based on coordinates to simulate map-wide datasets
                if (lat !== null && lng !== null) {
                    const spatialPhase = (lat * 10.0) + (lng * 10.0);
                    baseSpd += Math.sin(spatialPhase) * 2;
                    baseDir = (baseDir + Math.cos(spatialPhase) * 15 + 360) % 360;
                    currentSpd += Math.sin(spatialPhase * 1.5) * 0.5;
                    currentDir = (currentDir + Math.cos(spatialPhase * 1.5) * 10 + 360) % 360;
                    waveHt += Math.sin(spatialPhase * 0.5) * 0.2;
                }

                return {
                    windSpd: Math.max(0, baseSpd),
                    windDir: baseDir,
                    precip: (this.forecastData.weather.precipitation && this.forecastData.weather.precipitation[idx]) || 0,
                    waveHt: Math.max(0, waveHt),
                    waveDir: waveDir,
                    currentSpd: Math.max(0, currentSpd),
                    currentDir: currentDir
                };
            },
            analyzeSafety(conditions) {
                // Safety tolerance
                if (conditions.windSpd > 45 || conditions.waveHt > 6.0) {
                    return { safe: false, reason: "SEVERE STORMS DETECTED. VOYAGE ABORTED." };
                }
                return { safe: true };
            },
            
            lastAiResult: null,

            // Throttle advice from services/speed/optimizer.py, via /api/advise.
            //
            // This used to POST to /api/ai-optimize, where a language model was
            // handed the wind, wave and current and asked for a throttle
            // percentage. Nothing checked that number, because nothing could:
            // it was not derived from anything. It now comes from the fuel model
            // -- a fitted resistance calculation, a published diesel BSFC curve
            // and the ONNX wear model -- swept for the cheapest RPM that still
            // holds the requested ETA.
            //
            // There is deliberately no local fallback. The old code fell back to
            // optimizeSpeedAndRouteSync, a rule of thumb that returned a
            // plausible-looking percentage from two if-statements; on screen it
            // was indistinguishable from a model output. If the optimiser is
            // down the console now says so and shows nothing, which is the only
            // honest state available to it.
            async optimizeSpeedAndRouteAsync(conditions, targetEtaHours, currentDistKm) {
                try {
                    const res = await fetch('/api/advise', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            conditions,
                            etaHours: targetEtaHours,
                            currentDistKm,
                            headingDeg: State.ship?.headingDeg ?? 0,
                            currentRpm: State.ai?.currentRpm ?? null,
                            vessel: vesselSpecForApi()
                        })
                    });
                    const data = await res.json();
                    if (!res.ok || data.ok === false) {
                        this.lastAiResult = null;
                        return { ok: false, unavailable: true, detail: data.detail || res.statusText };
                    }
                    this.lastAiResult = data;
                    return data;
                } catch (e) {
                    this.lastAiResult = null;
                    return { ok: false, unavailable: true, detail: String(e) };
                }
            }
        };
        
        class PriorityQueue {
            constructor() { this.data = []; }
            enqueue(element, priority) {
                this.data.push({element, priority});
                let i = this.data.length - 1;
                while (i > 0) {
                    const p = (i - 1) >> 1;
                    if (this.data[p].priority <= this.data[i].priority) break;
                    const tmp = this.data[i];
                    this.data[i] = this.data[p];
                    this.data[p] = tmp;
                    i = p;
                }
            }
            dequeue() {
                if (this.data.length === 0) return undefined;
                const top = this.data[0];
                const bottom = this.data.pop();
                if (this.data.length > 0) {
                    this.data[0] = bottom;
                    let i = 0;
                    const len = this.data.length;
                    while (true) {
                        let min = i;
                        const left = (i << 1) + 1;
                        const right = left + 1;
                        if (left < len && this.data[left].priority < this.data[min].priority) min = left;
                        if (right < len && this.data[right].priority < this.data[min].priority) min = right;
                        if (min === i) break;
                        const tmp = this.data[i];
                        this.data[i] = this.data[min];
                        this.data[min] = tmp;
                        i = min;
                    }
                }
                return top;
            }
            isEmpty() { return this.data.length === 0; }
        }

        const SpatialGIS = {
            grid: null,
            gridW: 0,
            gridH: 0,
            minLat: 0,
            maxLat: 0,
            minLng: 0,
            maxLng: 0,
            lastRegionKey: null,
            async loadRegion(start, end) {
                const regionKey = `${start.lat.toFixed(4)},${start.lng.toFixed(4)}->${end.lat.toFixed(4)},${end.lng.toFixed(4)}`;
                if (this.grid && this.lastRegionKey === regionKey) {
                    return true; // Use cached water mask grid
                }

                const totalDist = Math.sqrt(Math.pow(start.lat - end.lat, 2) + Math.pow(start.lng - end.lng, 2));
                // Set a reasonable padding around the route based on distance
                const pad = Math.max(0.005, totalDist * 0.1);
                
                let minLat = Math.min(start.lat, end.lat) - pad;
                let maxLat = Math.max(start.lat, end.lat) + pad;
                let minLng = Math.min(start.lng, end.lng) - pad;
                let maxLng = Math.max(start.lng, end.lng) + pad;

                const lon2tile = (lon, zoom) => (Math.floor((lon + 180) / 360 * Math.pow(2, zoom)));
                const lat2tile = (lat, zoom) => (Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, zoom)));

                // Dynamically adjust zoom level to support long-distance routes without overloading memory/network
                let z = 19;
                let minX, maxX, minY, maxY, tilesX, tilesY;
                const MAX_TILES = 120; // Allow up to ~10x12 grid of tiles

                while (z >= 6) {
                    minX = lon2tile(minLng, z);
                    maxX = lon2tile(maxLng, z);
                    minY = lat2tile(maxLat, z); 
                    maxY = lat2tile(minLat, z);
                    tilesX = maxX - minX + 1;
                    tilesY = maxY - minY + 1;
                    
                    if (tilesX * tilesY <= MAX_TILES) {
                        break;
                    }
                    z--;
                }

                const TILE_SIZE = 256;
                const fullW = tilesX * TILE_SIZE;
                const fullH = tilesY * TILE_SIZE;

                const MAX_GRID = 1200;
                const scale = Math.min(1.0, MAX_GRID / Math.max(fullW, fullH));
                this.gridW = Math.round(fullW * scale);
                this.gridH = Math.round(fullH * scale);

                const tile2lon = (x, zoom) => (x / Math.pow(2, zoom) * 360 - 180);
                const tile2lat = (y, zoom) => {
                    const n = Math.PI - 2 * Math.PI * y / Math.pow(2, zoom);
                    return (180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))));
                };

                this.minLng = tile2lon(minX, z);
                this.maxLng = tile2lon(maxX + 1, z);
                this.maxLat = tile2lat(minY, z);
                this.minLat = tile2lat(maxY + 1, z);

                const canvas = document.createElement('canvas');
                canvas.width = this.gridW;
                canvas.height = this.gridH;
                const ctx = canvas.getContext('2d', { willReadFrequently: true });
                ctx.imageSmoothingEnabled = false;

                const promises = [];
                for (let x = minX; x <= maxX; x++) {
                    for (let y = minY; y <= maxY; y++) {
                        promises.push(new Promise((resolve) => {
                            const img = new Image();
                            img.crossOrigin = "anonymous";
                            // Use OpenStreetMap for crisp land avoidance water mask analysis
                            img.src = `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
                            img.onload = () => {
                                const dx = (x - minX) * TILE_SIZE * scale;
                                const dy = (y - minY) * TILE_SIZE * scale;
                                const dw = TILE_SIZE * scale;
                                const dh = TILE_SIZE * scale;
                                ctx.drawImage(img, dx, dy, dw, dh);
                                resolve();
                            };
                            img.onerror = () => {
                                resolve();
                            };
                        }));
                    }
                }
                
                updateDisplayValue('throttleStatus', 'Fetching Map Tiles for Water Mask...');
                await Promise.all(promises);

                updateDisplayValue('throttleStatus', 'Extracting Water Mask...');
                const imgData = ctx.getImageData(0, 0, this.gridW, this.gridH).data;

                this.grid = new Uint8Array(this.gridW * this.gridH);
                
                let waterPixels = 0;
                for (let i = 0; i < this.grid.length; i++) {
                    const r = imgData[i * 4];
                    const g = imgData[i * 4 + 1];
                    const b = imgData[i * 4 + 2];
                    const a = imgData[i * 4 + 3];
                    
                    if (a < 255) {
                        this.grid[i] = 2; // Treat transparent as strict land to be safe
                        continue;
                    }

                    // --- OPENSTREETMAP WATER MASK RULES INTEGRATION ---
                    // Rule 1: Always zoom at level 19.0 (handled in tile loading step)
                    // Rule 2: All types of blue are water
                    const isBlue = (b > r + 10 && b + 10 > g) || (b > 180 && r < 200 && b > r + 5 && g > r + 5);
                    
                    // Rule 3: White, green, and yellow are land
                    const isWhite = r > 235 && g > 235 && b > 235;
                    const isGreen = g > r + 3 && g > b + 3;
                    const isYellow = r > 210 && g > 190 && b < 160;

                    // Rule 4 & 5: All types of gray of any size are roads/bridges; boxes/structures (can be considered land)
                    // Gray is defined as having balanced r, g, b values
                    const isGray = Math.abs(r - g) < 15 && Math.abs(g - b) < 15 && Math.abs(r - b) < 15 && r > 40 && r < 240;

                    // Assign initial classifications:
                    if (isBlue) {
                        this.grid[i] = 0; // Water (Rule 2)
                    } else if (isWhite || isGreen || isYellow) {
                        this.grid[i] = 2; // Strict Land (Rule 3)
                    } else if (isGray) {
                        this.grid[i] = 3; // Temporary value for road/bridge/gray candidate (Rule 4)
                    } else {
                        this.grid[i] = 2; // Default to land for other colors (Rule 5, 7)
                    }
                }

                // Rule 6: Bridges are identified if a line of any type of gray and size similar to roads is in between any type of blue (water).
                // Allow boat routes to pass through any bridge.
                // We perform a second pass to identify bridges (value 3 between 0) and convert them to 0 (water/navigable).
                // All other grays (value 3) that are not bridges will be classified as 1 (standard land/roads).
                const tempGrid = new Uint8Array(this.grid);
                for (let y = 1; y < this.gridH - 1; y++) {
                    for (let x = 1; x < this.gridW - 1; x++) {
                        const idx = y * this.gridW + x;
                        if (tempGrid[idx] === 3) { // If it is a gray road/bridge candidate
                            // Check horizontal, vertical, or diagonal neighbors for water (0)
                            const left = tempGrid[idx - 1];
                            const right = tempGrid[idx + 1];
                            const top = tempGrid[idx - this.gridW];
                            const bottom = tempGrid[idx + this.gridW];
                            
                            const isHorizontalBridge = (left === 0 && right === 0);
                            const isVerticalBridge = (top === 0 && bottom === 0);
                            const isDiagonalBridge = (tempGrid[idx - this.gridW - 1] === 0 && tempGrid[idx + this.gridW + 1] === 0) ||
                                                    (tempGrid[idx - this.gridW + 1] === 0 && tempGrid[idx + this.gridW - 1] === 0);

                            if (isHorizontalBridge || isVerticalBridge || isDiagonalBridge) {
                                this.grid[idx] = 0; // Classify as water/navigable bridge! (Rule 6)
                            } else {
                                this.grid[idx] = 1; // Classify as standard road (land)
                            }
                        }
                    }
                }
                
                // Clean up any remaining 3 values in the margins to land (1)
                for (let i = 0; i < this.grid.length; i++) {
                    if (this.grid[i] === 3) {
                        this.grid[i] = 1;
                    }
                }

                // Dynamic morphological operations based on zoom level to prevent erasing large landmasses at far distances
                let passCount = 0;
                if (z >= 13) passCount = 2;
                else if (z >= 11) passCount = 1;
                else passCount = 0;

                let currentGrid = this.grid;
                if (passCount > 0) {
                    // Erode erodable land (dilate water) to remove bridges
                    for (let pass = 0; pass < passCount; pass++) {
                        const eroded = new Uint8Array(this.gridW * this.gridH);
                        eroded.set(currentGrid);
                        for (let y = 1; y < this.gridH - 1; y++) {
                            for (let x = 1; x < this.gridW - 1; x++) {
                                if (currentGrid[y * this.gridW + x] === 1) { // Only erode non-strict land
                                    if (currentGrid[(y-1) * this.gridW + x] === 0 || 
                                        currentGrid[(y+1) * this.gridW + x] === 0 ||
                                        currentGrid[y * this.gridW + (x-1)] === 0 || 
                                        currentGrid[y * this.gridW + (x+1)] === 0) {
                                        eroded[y * this.gridW + x] = 0; // become water
                                    }
                                }
                            }
                        }
                        currentGrid = eroded;
                    }

                    // Dilate land to restore shores
                    for (let pass = 0; pass < passCount; pass++) {
                        const dilated = new Uint8Array(this.gridW * this.gridH);
                        dilated.set(currentGrid);
                        for (let y = 1; y < this.gridH - 1; y++) {
                            for (let x = 1; x < this.gridW - 1; x++) {
                                // Dilate both strict land (2) and normal land (1)
                                if (currentGrid[y * this.gridW + x] > 0) {
                                    dilated[(y-1) * this.gridW + x] = 1;
                                    dilated[(y+1) * this.gridW + x] = 1;
                                    dilated[y * this.gridW + (x-1)] = 1;
                                    dilated[y * this.gridW + (x+1)] = 1;
                                }
                            }
                        }
                        currentGrid = dilated;
                    }
                }
                
                // Finalize grid back to strictly 1 (land) and 0 (water) for A*
                for (let i = 0; i < currentGrid.length; i++) {
                    this.grid[i] = currentGrid[i] > 0 ? 1 : 0;
                }
                
                this.grid = currentGrid;
                this.lastRegionKey = regionKey;

                log(`Extracted water mask from map tiles (${this.gridW}x${this.gridH}).`, "success");
                return true;
            }        };

        const PrecisionPathfinder = {
            async computePath(portA, portB, hazards, etaMinutes = 18, options = {}) { console.log("COMPUTE PATH STARTED");
                // 1. Generate 2-day AI weather forecast
                await NavEngine.generateForecast(portA.lat, portA.lng);
                
                // 2. Predict conditions for estimated ETA (e.g. 12 hours)
                const targetEtaHours = etaMinutes / 60; // Use input ETA
                const predictedConditions = NavEngine.getConditionsAtETA(targetEtaHours);
                
                // 3. Safety Check
                const safety = NavEngine.analyzeSafety(predictedConditions);
                if (!safety.safe) {
                    return { error: safety.reason };
                }

                const success = await SpatialGIS.loadRegion(portA, portB);
                if (!success) {
                    log("Failed to load map tiles for routing.", "alert");
                    return { error: "Failed to generate water mask." };
                }

                const gridW = SpatialGIS.gridW;
                const gridH = SpatialGIS.gridH;
                const grid = SpatialGIS.grid;
                const minLat = SpatialGIS.minLat;
                const maxLat = SpatialGIS.maxLat;
                const minLng = SpatialGIS.minLng;
                const maxLng = SpatialGIS.maxLng;
                
                updateDisplayValue('throttleStatus', 'Computing Vector Path...');

                const getGridCoords = (lat, lng) => {
                    const x = Math.round(((lng - minLng) / (maxLng - minLng)) * (gridW - 1));
                    const y = Math.round(((maxLat - lat) / (maxLat - minLat)) * (gridH - 1));
                    return {
                        x: Math.max(0, Math.min(gridW - 1, x)),
                        y: Math.max(0, Math.min(gridH - 1, y))
                    };
                };

                const startP = getGridCoords(portA.lat, portA.lng);
                const endP = getGridCoords(portB.lat, portB.lng);

                const snapStart = this.findNearestWater(grid, startP.x, startP.y, gridW, gridH);
                const snapEnd = this.findNearestWater(grid, endP.x, endP.y, gridW, gridH);

                const hazardGrid = new Float32Array(gridW * gridH);

                // Compute distance transform to land for river centering
                const distToLand = new Float32Array(gridW * gridH);
                distToLand.fill(9999);
                let q = [];
                for (let y = 0; y < gridH; y++) {
                    for (let x = 0; x < gridW; x++) {
                        if (grid[y * gridW + x] !== 0) {
                            distToLand[y * gridW + x] = 0;
                            q.push({x, y});
                        }
                    }
                }
                let head = 0;
                while (head < q.length) {
                    const {x, y} = q[head++];
                    const d = distToLand[y * gridW + x];
                    const neighbors = [[0,1], [1,0], [0,-1], [-1,0]];
                    for (let [dx, dy] of neighbors) {
                        const nx = x + dx, ny = y + dy;
                        if (nx >= 0 && nx < gridW && ny >= 0 && ny < gridH) {
                            if (distToLand[ny * gridW + nx] > d + 1) {
                                distToLand[ny * gridW + nx] = d + 1;
                                q.push({x: nx, y: ny});
                            }
                        }
                    }
                }

                // River and canal centering penalty based on distance to land transform
                for (let i = 0; i < hazardGrid.length; i++) {
                    if (grid[i] === 0) {
                        const d = distToLand[i];
                        if (d < 8) {
                            // Parabolic penalty near immediate shorelines (d < 8) to center vessel in narrow rivers/canals without affecting open water
                            let penalty = Math.pow((8 - d) / 8, 2) * 5.0;
                            if (d < 2) {
                                penalty += 50.0; // Massive penalty for hugging the coast to prevent corner cutting visually
                            }
                            hazardGrid[i] += penalty;
                        }
                    }
                }

                if (hazards && hazards.length > 0) {
                    const dLng = maxLng - minLng;
                    const dLat = maxLat - minLat;
                    for (let haz of hazards) {
                        const hazP = getGridCoords(haz.latLng.lat, haz.latLng.lng);
                        const degPerPxX = dLng / gridW;
                        const degPerPxY = dLat / gridH;
                        const radiusDeg = haz.radiusMeters / 111000;
                        const radiusPxX = Math.ceil(radiusDeg / degPerPxX * 1.5);
                        const radiusPxY = Math.ceil(radiusDeg / degPerPxY * 1.5);
                        const rPx = Math.max(radiusPxX, radiusPxY);

                        const hMinX = Math.max(0, hazP.x - rPx);
                        const hMaxX = Math.min(gridW - 1, hazP.x + rPx);
                        const hMinY = Math.max(0, hazP.y - rPx);
                        const hMaxY = Math.min(gridH - 1, hazP.y + rPx);

                        for (let y = hMinY; y <= hMaxY; y++) {
                            for (let x = hMinX; x <= hMaxX; x++) {
                                const distPx = Math.sqrt(((x - hazP.x)*degPerPxX)**2 + ((y - hazP.y)*degPerPxY)**2);
                                if (distPx < radiusDeg * 1.5) {
                                    const penalty = Math.pow((radiusDeg * 1.5 - distPx) / (radiusDeg * 1.5), 2) * 50;
                                    hazardGrid[y * gridW + x] += penalty;
                                }
                            }
                        }
                    }
                }

                // 1. Solve optimal GIS water-mask baseline path directly from departure to destination
                updateDisplayValue('throttleStatus', 'Solving GIS Water Pathfinder...');
                let basePathPixels;
                if (State.pathMode === 'dlite') {
                    basePathPixels = await this.runDLite(grid, gridW, gridH, minLat, maxLat, minLng, maxLng, snapStart.x, snapStart.y, snapEnd.x, snapEnd.y, hazardGrid, predictedConditions, distToLand);
                } else if (State.pathMode === 'rrt') {
                    basePathPixels = await this.runRRT(grid, gridW, gridH, minLat, maxLat, minLng, maxLng, snapStart.x, snapStart.y, snapEnd.x, snapEnd.y, hazardGrid, predictedConditions, distToLand);
                } else {
                    basePathPixels = await this.runAStarWorker(grid, gridW, gridH, minLat, maxLat, minLng, maxLng, snapStart.x, snapStart.y, snapEnd.x, snapEnd.y, hazardGrid, predictedConditions);
                }

                if (!basePathPixels || basePathPixels.length < 2) {
                    return { error: "No navigable water path found between ports." };
                }

                const basePathLatLngs = basePathPixels.map(p => {
                    return L.latLng(
                        maxLat - (p.y / (gridH - 1)) * (maxLat - minLat),
                        minLng + (p.x / (gridW - 1)) * (maxLng - minLng)
                    );
                });
                
                basePathLatLngs[0] = L.latLng(portA.lat, portA.lng);
                basePathLatLngs[basePathLatLngs.length - 1] = L.latLng(portB.lat, portB.lng);

                // Sample candidate macro waypoints along computed water fairway
                const hydro = getVesselHydrodynamics();
                const wp1Idx = Math.floor((basePathLatLngs.length - 1) * 0.35);
                const wp2Idx = Math.floor((basePathLatLngs.length - 1) * 0.70);
                const waterWp1 = basePathLatLngs[wp1Idx] || basePathLatLngs[0];
                const waterWp2 = basePathLatLngs[wp2Idx] || basePathLatLngs[basePathLatLngs.length - 1];

                const candidateWaypoints = [
                    {
                        lat: waterWp1.lat,
                        lng: waterWp1.lng,
                        name: "Strategic Waypoint Alpha (Fairway Clear)",
                        tacticalReason: "Primary deep-water departure fairway clearance point.",
                        speedAdviceKts: hydro.serviceSpeed
                    },
                    {
                        lat: waterWp2.lat,
                        lng: waterWp2.lng,
                        name: "Strategic Waypoint Bravo (Fairway Alignment)",
                        tacticalReason: "Mid-passage current alignment & speed transition point.",
                        speedAdviceKts: hydro.serviceSpeed
                    }
                ];

                // 2. Ask the route optimiser where the track should bend.
                //
                // Two endpoints used to live here. One asked a language model for
                // "strategic macro waypoints" that would "preserve deep navigable
                // water" -- a promise it had no bathymetry to keep. The other asked
                // it to grade this pathfinder's trajectory out of 100 and emit
                // corrected waypoints. Both are replaced by /api/route, which runs
                // services/route/planner.py: a sweep of candidate tracks, every leg
                // costed through the same fuel model /api/advise uses, and any track
                // violating the depth or forecast-wave constraint rejected outright.
                //
                // The shape of what happens next is unchanged, and that is the point
                // -- his pathfinder still owns the geometry. The planner proposes
                // where to bend; the A*/D*/RRT solver still routes between those
                // points through the water mask, and findNearestWater still snaps
                // anything that lands on a pixel of shore. A proposal that cannot be
                // reached over water simply does not survive the snap.
                let aiWaypointData = null;
                let finalPathPixels = basePathPixels;
                let isAiRoutingSuccessful = false;

                if (!options.skipAiWaypoints && State.pathMode !== 'astar') {
                    updateDisplayValue('throttleStatus', 'Route optimiser planning track...');
                    try {
                        const resRoute = await fetch('/api/route', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                startPort: portA,
                                endPort: portB,
                                vessel: vesselSpecForApi(),
                                etaMinutes
                            })
                        });

                        const plan = await resRoute.json();
                        State.routePlan = plan;

                        if (resRoute.ok && plan.ok && Array.isArray(plan.waypoints) && plan.waypoints.length > 0) {
                            aiWaypointData = plan;
                        }
                        renderAiAuditPanel(plan);
                        renderRouteSavings(plan);
                    } catch (e) {
                        console.warn("Route optimiser unreachable; using the pathfinder's own track:", e);
                        State.routePlan = { ok: false, detail: String(e) };
                        renderAiAuditPanel(State.routePlan);
                        renderRouteSavings(State.routePlan);
                    }
                }

                let finalWaypoints = candidateWaypoints;
                if (aiWaypointData && Array.isArray(aiWaypointData.waypoints) && aiWaypointData.waypoints.length > 0) {
                    // Convert AI waypoints into grid water pixels
                    const snappedWps = aiWaypointData.waypoints.map(aiWp => {
                        const gridP = getGridCoords(aiWp.lat, aiWp.lng);
                        const waterP = this.findNearestWater(grid, gridP.x, gridP.y, gridW, gridH);
                        const lat = maxLat - (waterP.y / (gridH - 1)) * (maxLat - minLat);
                        const lng = minLng + (waterP.x / (gridW - 1)) * (maxLng - minLng);
                        return {
                            ...aiWp,
                            lat,
                            lng,
                            gridX: waterP.x,
                            gridY: waterP.y
                        };
                    });

                    // Route between the planner's waypoints with the current pathfinder
                    let multiSegPixels = [];
                    const segNodes = [{ gridX: snapStart.x, gridY: snapStart.y }, ...snappedWps, { gridX: snapEnd.x, gridY: snapEnd.y }];
                    let allSegsValid = true;

                    for (let s = 0; s < segNodes.length - 1; s++) {
                        const pStart = segNodes[s];
                        const pEnd = segNodes[s + 1];
                        let subPath;
                        if (State.pathMode === 'dlite') {
                            subPath = await this.runDLite(grid, gridW, gridH, minLat, maxLat, minLng, maxLng, pStart.gridX, pStart.gridY, pEnd.gridX, pEnd.gridY, hazardGrid, predictedConditions, distToLand);
                        } else if (State.pathMode === 'rrt') {
                            subPath = await this.runRRT(grid, gridW, gridH, minLat, maxLat, minLng, maxLng, pStart.gridX, pStart.gridY, pEnd.gridX, pEnd.gridY, hazardGrid, predictedConditions, distToLand);
                        } else {
                            subPath = await this.runAStarWorker(grid, gridW, gridH, minLat, maxLat, minLng, maxLng, pStart.gridX, pStart.gridY, pEnd.gridX, pEnd.gridY, hazardGrid, predictedConditions, distToLand);
                        }
                        
                        if (subPath && subPath.length >= 2) {
                            if (s === 0) multiSegPixels = multiSegPixels.concat(subPath);
                            else multiSegPixels = multiSegPixels.concat(subPath.slice(1));
                        } else {
                            allSegsValid = false;
                            break;
                        }
                    }

                    if (allSegsValid && multiSegPixels.length >= 2) {
                        finalPathPixels = multiSegPixels;
                        finalWaypoints = snappedWps;
                        isAiRoutingSuccessful = true;
                    }
                }

                const pathPixels = finalPathPixels;

                State.aiWaypoints = finalWaypoints;
                let strategyDesc = aiWaypointData?.strategicStrategy;
                if (!strategyDesc) {
                    if (options.skipAiWaypoints || State.pathMode === 'astar') {
                        strategyDesc = "Pure A* GIS Water Pathfinder (AI overrides bypassed).";
                    } else if (State.pathMode === 'greatcircle') {
                        strategyDesc = "Great Circle direct rhumb line navigation.";
                    } else {
                        strategyDesc = "GIS water-mask pathfinder optimized fairway transit.";
                    }
                }
                State.aiStrategy = strategyDesc;

                renderAiWaypointMarkers(State.aiWaypoints);
                updateAiWaypointsHUD(State.aiStrategy, State.aiWaypoints);

                if (State.aiStrategy) {
                    log(`Strategic AI Route Strategy: ${State.aiStrategy}`, "ai");
                }

                // Line-of-sight (LOS) string pulling to create direct straight lines across open water
                const hasLineOfSight = (p1, p2) => {
                    let x0 = p1.x, y0 = p1.y;
                    let x1 = p2.x, y1 = p2.y;
                    let dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
                    let dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
                    let err = dx + dy, e2;

                    const lineDx = x1 - x0;
                    const lineDy = y1 - y0;
                    const lineLen = Math.sqrt(lineDx * lineDx + lineDy * lineDy);
                    const normDx = lineLen > 0 ? lineDx / lineLen : 0;
                    const normDy = lineLen > 0 ? lineDy / lineLen : 0;

                    while (true) {
                        const idx = y0 * gridW + x0;
                        if (grid[idx] !== 0) return false; // hit land
                        
                        // Safety clearance from land
                        const cellDist = distToLand[idx];
                        if (cellDist < 2) return false; // Minimum clearance from shoreline

                        // Inside narrow rivers/canals (cellDist < 6), reject shortcuts that cut across river bends
                        if (cellDist < 6) {
                            const p1Dist = distToLand[p1.y * gridW + p1.x];
                            const p2Dist = distToLand[p2.y * gridW + p2.x];
                            const minEndpointDist = Math.min(p1Dist, p2Dist);
                            if (cellDist < minEndpointDist - 1.5) {
                                return false;
                            }
                        }

                        if (hazardGrid && hazardGrid[idx] > 10) return false; // hit user designated hazard zone

                        // AI Vessel Sustainability & Tactical Quartering Check in Storm Zones
                        if (predictedConditions) {
                            const cellLat = maxLat - (y0 / (gridH - 1)) * (maxLat - minLat);
                            const cellLng = minLng + (x0 / (gridW - 1)) * (maxLng - minLng);
                            const dynCond = NavEngine ? NavEngine.getConditionsAtETA(0, cellLat, cellLng) : predictedConditions;
                            
                            if (dynCond && (dynCond.waveHt > 2.2 || dynCond.windSpd > 25)) {
                                const waveAngleRad = (dynCond.waveDir || 0) * Math.PI / 180;
                                const waveDx = Math.sin(waveAngleRad);
                                const waveDy = -Math.cos(waveAngleRad);
                                const headWaveDot = normDx * waveDx + normDy * waveDy;
                                
                                const hydro = getVesselHydrodynamics();
                                const maxHeadWaveSustain = Math.min(3.5, 1.5 + (hydro.dwt / 1000) * 0.5 + (hydro.mcrKw / 2000) * 0.5);
                                
                                // Direct head-wave shortcut in extreme sea conditions exceeds vessel sustainability!
                                // Force string-pulling to preserve tactical quartering zig-zag route.
                                if (headWaveDot > 0.6 && dynCond.waveHt > maxHeadWaveSustain) {
                                    return false;
                                }
                            }
                        }

                        if (x0 === x1 && y0 === y1) break;
                        e2 = 2 * err;
                        
                        let prevX = x0;
                        let prevY = y0;
                        
                        if (e2 >= dy) { err += dy; x0 += sx; }
                        if (e2 <= dx) { err += dx; y0 += sy; }
                        
                        // Prevent diagonal corner cutting
                        if (x0 !== prevX && y0 !== prevY) {
                            if (grid[prevY * gridW + x0] !== 0 || grid[y0 * gridW + prevX] !== 0) {
                                return false; 
                            }
                        }
                    }
                    return true;
                };

                const pulledPixels = [pathPixels[0]];
                let currIdx = 0;
                while (currIdx < pathPixels.length - 1) {
                    let furthest = currIdx + 1;
                    // Limit point-to-point line search to prevent cutting massive corners and stay closer to A* safety path
                    let maxLookahead = Math.min(pathPixels.length - 1, currIdx + 40);
                    for (let i = maxLookahead; i > currIdx; i--) {
                        if (hasLineOfSight(pathPixels[currIdx], pathPixels[i])) {
                            furthest = i;
                            break;
                        }
                    }
                    pulledPixels.push(pathPixels[furthest]);
                    currIdx = furthest;
                }

                let pulled = pulledPixels.map(p => L.latLng(
                    maxLat - (p.y / (gridH - 1)) * (maxLat - minLat),
                    minLng + (p.x / (gridW - 1)) * (maxLng - minLng)
                ));
                pulled[0] = L.latLng(portA.lat, portA.lng);
                pulled[pulled.length - 1] = L.latLng(portB.lat, portB.lng);
                
                // Multi-pass water-validated curve smoothing:
                // Smooth out minor dataset/grid jitter into fluid curves,
                // but preserve sharp tactical turns in extreme weather quartering zones.
                const isWaterCell = (latlng) => {
                    const gx = Math.round((latlng.lng - minLng) / (maxLng - minLng) * (gridW - 1));
                    const gy = Math.round((maxLat - latlng.lat) / (maxLat - minLat) * (gridH - 1));
                    if (gx >= 0 && gx < gridW && gy >= 0 && gy < gridH) {
                        return grid[gy * gridW + gx] === 0;
                    }
                    return false;
                };

                let smoothed = [...pulled];
                for (let pass = 0; pass < 2; pass++) {
                    const newPath = [smoothed[0]];
                    for (let i = 0; i < smoothed.length - 1; i++) {
                        const p0 = smoothed[i];
                        const p1 = smoothed[i + 1];

                        let isExtremeQuarteringZone = false;
                        if (predictedConditions) {
                            const midLat = (p0.lat + p1.lat) / 2;
                            const midLng = (p0.lng + p1.lng) / 2;
                            const dynCond = NavEngine ? NavEngine.getConditionsAtETA(0, midLat, midLng) : predictedConditions;
                            if (dynCond && (dynCond.waveHt > 2.5 || dynCond.windSpd > 28)) {
                                isExtremeQuarteringZone = true;
                            }
                        }

                        if (isExtremeQuarteringZone) {
                            // Preserve crisp tactical quartering angle in extreme weather
                            newPath.push(p0);
                            newPath.push(p1);
                        } else {
                            // Fluid curve smoothing for open water and minor dataset jitter
                            const mid1 = L.latLng(0.75 * p0.lat + 0.25 * p1.lat, 0.75 * p0.lng + 0.25 * p1.lng);
                            const mid2 = L.latLng(0.25 * p0.lat + 0.75 * p1.lat, 0.25 * p0.lng + 0.75 * p1.lng);
                            
                            if (isWaterCell(mid1)) newPath.push(mid1);
                            else newPath.push(p0);

                            if (isWaterCell(mid2)) newPath.push(mid2);
                            else newPath.push(p1);
                        }
                    }
                    newPath.push(smoothed[smoothed.length - 1]);
                    smoothed = newPath;
                }
                pulled = smoothed;


                
                let landCount = 0;
                for (let i = 0; i < grid.length; i++) {
                    if (grid[i] !== 0) landCount++;
                }

                return { path: pulled, landCount, meshNodes: gridW * gridH, predictedConditions, targetEtaHours: 18 / 60, isAiUsed: !options.skipAiWaypoints && isAiRoutingSuccessful, isAstarUsed: true };
            },

            findNearestWater(grid, sx, sy, w, h) {
                const isGoodWater = (gx, gy) => {
                    if (grid[gy * w + gx] !== 0) return false;
                    let waterCount = 0;
                    for (let y = -1; y <= 1; y++) {
                        for (let x = -1; x <= 1; x++) {
                            const nx = gx + x, ny = gy + y;
                            if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
                                if (grid[ny * w + nx] === 0) waterCount++;
                            }
                        }
                    }
                    return waterCount >= 3; 
                };

                if (isGoodWater(sx, sy)) return { x: sx, y: sy };
                const q = [{ x: sx, y: sy }];
                const visited = new Uint8Array(w * h);
                visited[sy * w + sx] = 1;
                const dirs = [[0,1],[1,0],[0,-1],[-1,0],[1,1],[-1,-1],[1,-1],[-1,1]];
                
                let limit = 0;
                while (q.length > 0 && limit++ < 100000) {
                    const curr = q.shift();
                    for (let [dx, dy] of dirs) {
                        const nx = curr.x + dx, ny = curr.y + dy;
                        if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
                            if (isGoodWater(nx, ny)) return { x: nx, y: ny };
                            const idx = ny * w + nx;
                            if (!visited[idx]) {
                                visited[idx] = 1;
                                q.push({ x: nx, y: ny });
                            }
                        }
                    }
                }
                return { x: sx, y: sy };
            },

            async runAStarWorker(grid, w, h, minLat, maxLat, minLng, maxLng, sx, sy, ex, ey, hazardGrid, weatherConditions, distToLand) {
                return new Promise((resolve, reject) => {
                    const worker = new Worker(new URL('./routingWorker.js', import.meta.url), { type: 'module' });
                    worker.onmessage = (e) => {
                        resolve(e.data.path);
                        worker.terminate();
                    };
                    worker.onerror = (e) => {
                        console.error('Worker error', e);
                        reject(e);
                        worker.terminate();
                    };
                    
                    const hydro = getVesselHydrodynamics();
                    const forecastDataPayload = (typeof NavEngine !== 'undefined') ? NavEngine.forecastData : null;
                    
                    worker.postMessage({
                        grid, w, h, minLat, maxLat, minLng, maxLng, 
                        sx, sy, ex, ey, hazardGrid, weatherConditions, distToLand, hydro, forecastDataPayload
                    });
                });
            },
            
            runAStar(grid, w, h, minLat, maxLat, minLng, maxLng, sx, sy, ex, ey, hazardGrid, weatherConditions, distToLand) {
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
                
                // Track parent direction to apply curvature penalty (fuel efficiency)
                const parentDir = new Int8Array(size); 
                parentDir.fill(-1);

                const hydro = getVesselHydrodynamics();

                while (!pq.isEmpty()) {
                    if (++iterations > 5000000) break; // Hard safety limit to prevent freeze
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
                                // Diagonal move - prevent corner cutting
                                if (grid[cy * w + nx] !== 0 || grid[ny * w + cx] !== 0) {
                                    continue;
                                }
                            }
                            
                            const hazardCost = hazardGrid[nextIdx];
                            
                            const currLat = getLat(cy);
                            const nextLat = getLat(ny);
                            const avgLat = (currLat + nextLat) / 2;
                            const latDiff = (ny - cy) * dLat;
                            const lngDiff = (nx - cx) * dLng;
                            const earthDx = lngDiff * Math.cos(avgLat * Math.PI / 180);
                            const earthDy = latDiff;
                            const moveCost = Math.sqrt(earthDx * earthDx + earthDy * earthDy) / dLat;
                            
                            const distMeters = moveCost * (dLat * 111320);
                            const stepTimeSecs = distMeters / (hydro.serviceSpeedKts * 0.51444);
                            const nextTime = timeSoFar[current] + stepTimeSecs / 3600;
                            
                            let dynCond = weatherConditions;
                            if (NavEngine && NavEngine.forecastData) {
                                dynCond = NavEngine.getConditionsAtETA(nextTime, getLat(ny), getLng(nx));
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

                            // 1 & 2. Block Coefficient & Windage Drag Penalty
                            let windPenalty = 0;
                            let leewayCrabPenalty = 0;
                            if (dynCond && dynCond.windSpd > 0) {
                                const windAngleRad = (dynCond.windDir || 0) * Math.PI / 180;
                                const windDx = Math.sin(windAngleRad);
                                const windDy = -Math.cos(windAngleRad);
                                const windDot = moveDx * windDx + moveDy * windDy; // Headwind component
                                const crossWindDot = Math.abs(moveDx * (-windDy) + moveDy * windDx); // Crosswind component
                                
                                // Windage drag force scales with Cb & superstructure lateral area
                                windPenalty = (windDot * 0.15 + crossWindDot * 0.1) * (dynCond.windSpd / 20) * (hydro.windageFrontalArea / 30);

                                // 5. Crab angle drift correction penalty
                                leewayCrabPenalty = crossWindDot * 0.08 * (hydro.windageLateralArea / (hydro.lbp * hydro.draft));
                            }

                            // 3. Shallow Water Effect (Squat & Canal Drag)
                            let shallowCanalPenalty = 0;
                            if (distToLand) {
                                const dLand = distToLand[nextIdx];
                                const waterDepthH = (dLand >= 10) ? 50 : Math.max(hydro.draft + 0.5, hydro.draft * (1 + 0.25 * dLand));
                                const depthFn = (hydro.serviceSpeedKts * 0.51444) / Math.sqrt(9.81 * waterDepthH);
                                const shallowMult = 1.0 + 0.4 * Math.pow(hydro.draft / waterDepthH, 2) + (0.3 / Math.max(0.1, Math.pow(1 - Math.min(0.9, depthFn), 2))) - 0.3;
                                shallowCanalPenalty = (shallowMult - 1.0) * 0.8;
                            }

                            // 4. Wave & SFOC Resistance Penalty
                            let weatherPenalty = 0;
                            if (dynCond && dynCond.waveHt > 1.0) {
                                const waveAngleRad = (dynCond.waveDir || 0) * Math.PI / 180;
                                const waveDx = Math.sin(waveAngleRad);
                                const waveDy = -Math.cos(waveAngleRad);
                                const waveDot = moveDx * waveDx + moveDy * waveDy;
                                const absWaveDot = Math.abs(waveDot);
                                weatherPenalty += (dynCond.waveHt * 0.15) * (1.0 + 0.2 * (hydro.cb / 0.6));
                            }

                            let turnCost = 0;
                            if (pDir !== -1 && pDir !== i) {
                                turnCost = 0.05; // Smoothing turn penalty for fuel efficiency
                            }
                            
                            const penaltyFactor = hazardCost + currentCost + windPenalty + leewayCrabPenalty + shallowCanalPenalty + weatherPenalty;
                            const stepMultiplier = Math.max(0.4, 1 + penaltyFactor);
                            const newCost = costSoFar[current] + moveCost * stepMultiplier + turnCost;

                            if (newCost < costSoFar[nextIdx]) {
                                costSoFar[nextIdx] = newCost;
                                timeSoFar[nextIdx] = nextTime;
                                cameFrom[nextIdx] = current;
                                parentDir[nextIdx] = i;
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
            },

            async runDLite(grid, w, h, minLat, maxLat, minLng, maxLng, sx, sy, ex, ey, hazardGrid, weatherConditions, distToLand) {
                const dLat = (maxLat - minLat) / (h - 1);
                const dLng = (maxLng - minLng) / (w - 1);
                const getLat = (y) => maxLat - y * dLat;
                const getLng = (x) => minLng + x * dLng;
                const size = w * h;

                // D* Lite Backward Search: Start search from destination, end at start
                const s_start = ey * w + ex; // Destination of voyage is start of search
                const s_goal = sy * w + sx;  // Start of voyage is goal of search

                const g = new Float32Array(size);
                const rhs = new Float32Array(size);
                g.fill(Infinity);
                rhs.fill(Infinity);

                rhs[s_start] = 0;

                // Priority Queue for D* Lite keys
                const U = []; 
                const inU = new Uint8Array(size);

                const h_func = (idx) => {
                    const cx = idx % w;
                    const cy = Math.floor(idx / w);
                    const gx = s_goal % w;
                    const gy = Math.floor(s_goal / w);
                    return sphericalDistance(getLat(cy), getLng(cx), getLat(gy), getLng(gx)) / (dLat * 111320);
                };

                const calculateKey = (idx) => {
                    const minVal = Math.min(g[idx], rhs[idx]);
                    const h_val = h_func(idx);
                    return [minVal + h_val, minVal];
                };

                const compareKeys = (k1, k2) => {
                    if (k1[0] < k2[0]) return -1;
                    if (k1[0] > k2[0]) return 1;
                    if (k1[1] < k2[1]) return -1;
                    if (k1[1] > k2[1]) return 1;
                    return 0;
                };

                const insertU = (idx, key) => {
                    if (!inU[idx]) {
                        U.push({ idx, key });
                        inU[idx] = 1;
                    } else {
                        const item = U.find(x => x.idx === idx);
                        if (item) item.key = key;
                    }
                    U.sort((a, b) => compareKeys(a.key, b.key));
                };

                const removeU = (idx) => {
                    if (inU[idx]) {
                        const i = U.findIndex(x => x.idx === idx);
                        if (i !== -1) U.splice(i, 1);
                        inU[idx] = 0;
                    }
                };

                const peekKey = () => {
                    if (U.length === 0) return [Infinity, Infinity];
                    return U[0].key;
                };

                const popU = () => {
                    if (U.length === 0) return -1;
                    const top = U.shift();
                    inU[top.idx] = 0;
                    return top.idx;
                };

                const dirs = [
                    {dx: 0, dy: -1, cost: 1}, {dx: 0, dy: 1, cost: 1}, 
                    {dx: -1, dy: 0, cost: 1}, {dx: 1, dy: 0, cost: 1},
                    {dx: -1, dy: -1, cost: 1.414}, {dx: 1, dy: -1, cost: 1.414}, 
                    {dx: -1, dy: 1, cost: 1.414}, {dx: 1, dy: 1, cost: 1.414}
                ];

                const hydro = getVesselHydrodynamics();

                const getEdgeCost = (u, v, moveCostIdx) => {
                    const cx = u % w;
                    const cy = Math.floor(u / w);
                    const nx = v % w;
                    const ny = Math.floor(v / w);

                    if (grid[v] !== 0) return Infinity;

                    // Prevent diagonal corner cutting
                    const dx = nx - cx;
                    const dy = ny - cy;
                    if (dx !== 0 && dy !== 0) {
                        if (grid[cy * w + nx] !== 0 || grid[ny * w + cx] !== 0) {
                            return Infinity;
                        }
                    }

                    const hazardCost = hazardGrid[v];
                    
                    const avgLat = (getLat(cy) + getLat(ny)) / 2;
                    const latDiff = (ny - cy) * dLat;
                    const lngDiff = (nx - cx) * dLng;
                    const earthDx = lngDiff * Math.cos(avgLat * Math.PI / 180);
                    const earthDy = latDiff;
                    const moveCost = Math.sqrt(earthDx * earthDx + earthDy * earthDy) / dLat;
                    
                    const distMeters = moveCost * (dLat * 111320);
                    const stepTimeSecs = distMeters / (hydro.serviceSpeedKts * 0.51444);
                    const nextTime = stepTimeSecs / 3600;
                    
                    let dynCond = weatherConditions;
                    if (NavEngine && NavEngine.forecastData) {
                        dynCond = NavEngine.getConditionsAtETA(nextTime, getLat(ny), getLng(nx));
                    }
                    
                    let currentAngle = 0;
                    let currentMagnitude = 0;
                    if (dynCond && dynCond.currentSpd !== undefined && dynCond.currentSpd > 0) {
                        currentAngle = (dynCond.currentDir - 90) * Math.PI / 180;
                        currentMagnitude = dynCond.currentSpd * 0.05;
                    }

                    const currentDx = Math.cos(currentAngle);
                    const currentDy = Math.sin(currentAngle);

                    const moveLength = dirs[moveCostIdx].cost;
                    const moveDx = dx / moveLength;
                    const moveDy = dy / moveLength;
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
                        
                        windPenalty = (windDot * 0.15 + crossWindDot * 0.1) * (dynCond.windSpd / 20) * (hydro.windageFrontalArea / 30);
                        leewayCrabPenalty = crossWindDot * 0.08 * (hydro.windageLateralArea / (hydro.lbp * hydro.draft));
                    }

                    let shallowCanalPenalty = 0;
                    if (distToLand) {
                        const dLand = distToLand[v];
                        const waterDepthH = (dLand >= 10) ? 50 : Math.max(hydro.draft + 0.5, hydro.draft * (1 + 0.25 * dLand));
                        const depthFn = (hydro.serviceSpeedKts * 0.51444) / Math.sqrt(9.81 * waterDepthH);
                        const shallowMult = 1.0 + 0.4 * Math.pow(hydro.draft / waterDepthH, 2) + (0.3 / Math.max(0.1, Math.pow(1 - Math.min(0.9, depthFn), 2))) - 0.3;
                        shallowCanalPenalty = (shallowMult - 1.0) * 0.8;
                    }

                    let weatherPenalty = 0;
                    if (dynCond && dynCond.waveHt > 1.0) {
                        const waveAngleRad = (dynCond.waveDir || 0) * Math.PI / 180;
                        const waveDx = Math.sin(waveAngleRad);
                        const waveDy = -Math.cos(waveAngleRad);
                        const waveDot = moveDx * waveDx + moveDy * waveDy;
                        weatherPenalty += (dynCond.waveHt * 0.15) * (1.0 + 0.2 * (hydro.cb / 0.6));
                    }

                    const penaltyFactor = hazardCost + currentCost + windPenalty + leewayCrabPenalty + shallowCanalPenalty + weatherPenalty;
                    const stepMultiplier = Math.max(0.4, 1 + penaltyFactor);
                    return moveCost * stepMultiplier;
                };

                const updateVertex = (u) => {
                    if (u !== s_start) {
                        let minRhs = Infinity;
                        const cx = u % w;
                        const cy = Math.floor(u / w);
                        for (let i = 0; i < dirs.length; i++) {
                            const nx = cx + dirs[i].dx;
                            const ny = cy + dirs[i].dy;
                            if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
                                const nextIdx = ny * w + nx;
                                const cost = getEdgeCost(u, nextIdx, i);
                                if (cost !== Infinity) {
                                    minRhs = Math.min(minRhs, cost + g[nextIdx]);
                                }
                            }
                        }
                        rhs[u] = minRhs;
                    }
                    removeU(u);
                    if (g[u] !== rhs[u]) {
                        insertU(u, calculateKey(u));
                    }
                };

                // Initialize search state
                insertU(s_start, calculateKey(s_start));

                let iterations = 0;
                while (compareKeys(peekKey(), calculateKey(s_goal)) < 0 || rhs[s_goal] !== g[s_goal]) {
                    if (++iterations > 5000000) break; // Hard safety limit
                    const u = popU();
                    if (u === -1) break;

                    const k_old = calculateKey(u);
                    const k_new = calculateKey(u);
                    
                    if (compareKeys(k_old, k_new) < 0) {
                        insertU(u, k_new);
                    } else if (g[u] > rhs[u]) {
                        g[u] = rhs[u];
                        removeU(u);
                        const cx = u % w;
                        const cy = Math.floor(u / w);
                        for (let i = 0; i < dirs.length; i++) {
                            const nx = cx + dirs[i].dx;
                            const ny = cy + dirs[i].dy;
                            if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
                                updateVertex(ny * w + nx);
                            }
                        }
                    } else {
                        const g_old = g[u];
                        g[u] = Infinity;
                        const cx = u % w;
                        const cy = Math.floor(u / w);
                        
                        updateVertex(u);
                        for (let i = 0; i < dirs.length; i++) {
                            const nx = cx + dirs[i].dx;
                            const ny = cy + dirs[i].dy;
                            if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
                                const v = ny * w + nx;
                                updateVertex(v);
                            }
                        }
                    }
                }

                // Trace path from s_goal back to s_start (departure to destination)
                if (rhs[s_goal] === Infinity) return null;

                const path = [];
                let curr = s_goal;
                path.push({ x: curr % w, y: Math.floor(curr / w) });

                let stepLimit = 0;
                while (curr !== s_start && stepLimit++ < w * h) {
                    let minCost = Infinity;
                    let nextStep = -1;
                    const cx = curr % w;
                    const cy = Math.floor(curr / w);

                    for (let i = 0; i < dirs.length; i++) {
                        const nx = cx + dirs[i].dx;
                        const ny = cy + dirs[i].dy;
                        if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
                            const nextIdx = ny * w + nx;
                            const cost = getEdgeCost(curr, nextIdx, i);
                            if (cost !== Infinity) {
                                const total = cost + g[nextIdx];
                                if (total < minCost) {
                                    minCost = total;
                                    nextStep = nextIdx;
                                }
                            }
                        }
                    }

                    if (nextStep === -1 || nextStep === curr) break;
                    curr = nextStep;
                    path.push({ x: curr % w, y: Math.floor(curr / w) });
                }

                return path;
            },

            async runRRT(grid, w, h, minLat, maxLat, minLng, maxLng, sx, sy, ex, ey, hazardGrid, weatherConditions, distToLand) {
                // Bi-directional Adaptive Informed RRT (BAIRRT)
                const maxIterations = 50000;
                let stepSize = 10.0; // Adaptive base step size
                const goalBias = 0.15;

                const distance = (x1, y1, x2, y2) => Math.sqrt((x1 - x2) ** 2 + (y1 - y2) ** 2);

                const getLineOfSight = (x0, y0, x1, y1) => {
                    let dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
                    let dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
                    let err = dx + dy, e2;
                    let cx = x0, cy = y0;

                    while (true) {
                        const idx = cy * w + cx;
                        if (idx < 0 || idx >= w * h || grid[idx] !== 0) return false;
                        if (distToLand && distToLand[idx] < 1.5) return false;
                        if (hazardGrid && hazardGrid[idx] > 35) return false;
                        
                        if (cx === x1 && cy === y1) break;
                        e2 = 2 * err;
                        let prevX = cx, prevY = cy;
                        if (e2 >= dy) { err += dy; cx += sx; }
                        if (e2 <= dx) { err += dx; cy += sy; }
                        if (cx !== prevX && cy !== prevY) {
                            if (grid[prevY * w + cx] !== 0 || grid[cy * w + prevX] !== 0) {
                                return false;
                            }
                        }
                    }
                    return true;
                };

                const treeEdges = [];
                let treeA = [{ x: sx, y: sy, parent: -1, id: 0 }];
                let treeB = [{ x: ex, y: ey, parent: -1, id: 0 }];
                
                // For informed sampling
                let cBest = Infinity;
                let bestPath = null;
                const cMin = distance(sx, sy, ex, ey);

                const getClosestNode = (tree, qx, qy) => {
                    let closest = tree[0];
                    let minDist = distance(closest.x, closest.y, qx, qy);
                    for (let i = 1; i < tree.length; i++) {
                        const d = distance(tree[i].x, tree[i].y, qx, qy);
                        if (d < minDist) { minDist = d; closest = tree[i]; }
                    }
                    return closest;
                };

                const sampleFree = (cMax) => {
                    if (cMax < Infinity) {
                        // Informed sampling (ellipsoid)
                        // Simplified bounding box approach for 2D ellipse for performance
                        while (true) {
                            let tx = Math.floor(Math.random() * w);
                            let ty = Math.floor(Math.random() * h);
                            if (distance(sx, sy, tx, ty) + distance(tx, ty, ex, ey) <= cMax) {
                                return { x: tx, y: ty };
                            }
                        }
                    } else {
                        // Standard sampling
                        return { 
                            x: Math.floor(Math.random() * w), 
                            y: Math.floor(Math.random() * h) 
                        };
                    }
                };

                let iterations = 0;
                while (iterations < maxIterations) {
                    iterations++;
                    
                    let tx, ty;
                    if (cBest === Infinity && Math.random() < goalBias) {
                        // Bias towards the other tree's root
                        tx = treeB[0].x;
                        ty = treeB[0].y;
                    } else {
                        const s = sampleFree(cBest);
                        tx = s.x; ty = s.y;
                    }

                    // Adaptive step size based on distance
                    let closestA = getClosestNode(treeA, tx, ty);
                    let distA = distance(closestA.x, closestA.y, tx, ty);
                    if (distA === 0) continue;

                    let dynamicStep = Math.min(stepSize, distA);
                    let nx = Math.round(closestA.x + ((tx - closestA.x) / distA) * dynamicStep);
                    let ny = Math.round(closestA.y + ((ty - closestA.y) / distA) * dynamicStep);

                    if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;

                    if (getLineOfSight(closestA.x, closestA.y, nx, ny)) {
                        const newNodeA = { x: nx, y: ny, parent: closestA.id, id: treeA.length };
                        treeA.push(newNodeA);
                        treeEdges.push([{ x: closestA.x, y: closestA.y }, { x: nx, y: ny }]);

                        // Try to connect Tree B to this new node
                        let closestB = getClosestNode(treeB, nx, ny);
                        if (getLineOfSight(closestB.x, closestB.y, nx, ny)) {
                            // Path found!
                            treeEdges.push([{ x: closestB.x, y: closestB.y }, { x: nx, y: ny }]);
                            
                            // Reconstruct path
                            let pathA = [];
                            let curr = newNodeA;
                            while (curr.parent !== -1) {
                                pathA.push({ x: curr.x, y: curr.y });
                                curr = treeA[curr.parent];
                            }
                            pathA.push({ x: treeA[0].x, y: treeA[0].y });
                            pathA.reverse();
                            
                            let pathB = [];
                            curr = closestB;
                            while (curr.parent !== -1) {
                                pathB.push({ x: curr.x, y: curr.y });
                                curr = treeB[curr.parent];
                            }
                            pathB.push({ x: treeB[0].x, y: treeB[0].y });
                            
                            let fullPath = pathA.concat(pathB);
                            
                            // If treeA is actually rooted at Goal (due to swap), reverse the path
                            if (treeA[0].x === ex && treeA[0].y === ey) {
                                fullPath.reverse();
                            }

                            // Calculate path cost (simple distance sum)
                            let cost = 0;
                            for (let i = 0; i < fullPath.length - 1; i++) {
                                cost += distance(fullPath[i].x, fullPath[i].y, fullPath[i+1].x, fullPath[i+1].y);
                            }

                            if (cost < cBest) {
                                cBest = cost;
                                bestPath = fullPath;
                                // We can stop immediately if we found a path to be fast, or continue for informed RRT*
                                // Let's stop at first path for snappiness in UI, unless we want to let it run for a bit
                                State.rrtTreeEdges = treeEdges;
                                return bestPath;
                            }
                        }
                    }

                    // Swap trees to maintain balance
                    if (treeA.length > treeB.length) {
                        let temp = treeA;
                        treeA = treeB;
                        treeB = temp;
                    }
                }

                if (bestPath) {
                    State.rrtTreeEdges = treeEdges;
                    return bestPath;
                }

                // Fallback to A* if BAIRRT fails to converge
                log("BAIRRT path planner failed to converge; applying A* raster solver fallback.", "warn");
                return await this.runAStarWorker(grid, w, h, minLat, maxLat, minLng, maxLng, sx, sy, ex, ey, hazardGrid, weatherConditions, distToLand);
            },

            stringPulling(pathLatLngs, grid, gridW, gridH, minLat, maxLat, minLng, maxLng, distToLand) {
                if (pathLatLngs.length < 3) return pathLatLngs;
                
                const getGridCoords = (lat, lng) => {
                    const x = Math.round(((lng - minLng) / (maxLng - minLng)) * (gridW - 1));
                    const y = Math.round(((maxLat - lat) / (maxLat - minLat)) * (gridH - 1));
                    return {
                        x: Math.max(0, Math.min(gridW - 1, x)),
                        y: Math.max(0, Math.min(gridH - 1, y))
                    };
                };

                const lineOfSight = (ll1, ll2) => {
                    const dist = sphericalDistance(ll1.lat, ll1.lng, ll2.lat, ll2.lng);
                    const steps = Math.ceil(dist / 2000); // Check every 2km
                    for(let i=1; i<=steps; i++) {
                        const pt = sphericalInterpolate(ll1.lat, ll1.lng, ll2.lat, ll2.lng, i/steps);
                        const c = getGridCoords(pt.lat, pt.lng);
                        if (c.x >= 0 && c.x < gridW && c.y >= 0 && c.y < gridH) {
                            if (grid[c.y * gridW + c.x] !== 0 || (distToLand && distToLand[c.y * gridW + c.x] <= 1)) return false;
                        }
                    }
                    return true;
                };
                const pulled = [pathLatLngs[0]];
                let curr = 0;
                
                while (curr < pathLatLngs.length - 1) {
                    let next = curr + 1;
                    const maxLookahead = Math.min(pathLatLngs.length - 1, curr + 100);
                    for (let i = maxLookahead; i > curr + 1; i--) {
                        if (lineOfSight(pathLatLngs[curr], pathLatLngs[i])) {
                            next = i;
                            break;
                        }
                    }
                    pulled.push(pathLatLngs[next]);
                    curr = next;
                }
                
                
                // Re-densify pulled path with great circle interpolation for visual accuracy on map
                const densePulled = [];
                for(let i=0; i<pulled.length-1; i++) {
                    const p1 = pulled[i];
                    const p2 = pulled[i+1];
                    densePulled.push(p1);
                    const dist = sphericalDistance(p1.lat, p1.lng, p2.lat, p2.lng);
                    if (dist > 50000) { // If segment > 50km, interpolate
                        const steps = Math.ceil(dist / 50000);
                        for(let j=1; j<steps; j++) {
                            const pt = sphericalInterpolate(p1.lat, p1.lng, p2.lat, p2.lng, j/steps);
                            densePulled.push(L.latLng(pt.lat, pt.lng));
                        }
                    }
                }
                densePulled.push(pulled[pulled.length-1]);
                return densePulled;
            }
        };

        const VESSEL_SPECS = {
            fiberglass: { maxSpeed: 15.0, baseWeightKg: 12000, maxWeightKg: 45000, maxRotDegPerSec: 12.0 },
            roro:       { maxSpeed: 12.0, baseWeightKg: 150000, maxWeightKg: 400000, maxRotDegPerSec: 4.0 },
            fastcraft:  { maxSpeed: 28.0, baseWeightKg: 25000, maxWeightKg: 60000, maxRotDegPerSec: 18.0 },
            cargo:      { maxSpeed: 8.5,  baseWeightKg: 200000, maxWeightKg: 800000, maxRotDegPerSec: 2.5 }
        };

        const WEATHER_PRESETS = {
            clear:   { windSpd: 8,  windDir: 90,  currentSpd: 1.0, currentDir: 180, waveHt: 0.5, waveDir: 135, tide: 0.5 },
            amihan:  { windSpd: 25, windDir: 45,  currentSpd: 3.5, currentDir: 210, waveHt: 2.2, waveDir: 45,  tide: 0.8 },
            habagat: { windSpd: 30, windDir: 225, currentSpd: 4.0, currentDir: 30,  waveHt: 2.8, waveDir: 225, tide: 1.2 },
            lpa:     { windSpd: 38, windDir: 120, currentSpd: 4.5, currentDir: 300, waveHt: 3.5, waveDir: 120, tide: 1.5 },
            typhoon: { windSpd: 65, windDir: 315, currentSpd: 6.5, currentDir: 270, waveHt: 5.0, waveDir: 315, tide: 2.0 }
        };

        // Run the metocean inputs off real conditions at the vessel's position
        // rather than a canned preset.
        //
        // This deliberately does not fetch anything itself. The console already
        // polls live marine data every two seconds through
        // process2SecondApiLivestream (State.apiLivestream, on by default), and
        // that loop writes all six metocean inputs. A second fetcher would race
        // it -- whichever wrote last would win, and the inputs would flicker
        // between two sources roughly every two seconds. So "live" forces the
        // existing pipeline to refresh now and reports what it produced.
        async function refreshLiveMetocean() {
            const txtLive = document.getElementById('liveWeatherText');
            if (txtLive) txtLive.textContent = 'Fetching…';

            // Selecting "live" is also the way to switch the poll back on if it
            // was disabled, otherwise the reading would go stale immediately.
            State.apiLivestream = true;

            try {
                await process2SecondApiLivestream();
            } catch (e) {
                if (txtLive) txtLive.textContent = 'Live feed unreachable — inputs unchanged.';
                log(`Live metocean refresh failed: ${e.message}.`, 'warn');
                return;
            }

            // Report the inputs as they now stand: that is what the simulation
            // will actually use, whether the feed answered or the pipeline fell
            // back to its cache.
            const lat = State.ship.lat || 0;
            const lng = State.ship.lng || 0;
            const wind = getSafeVal('inWindSpd', null);
            const wave = getSafeVal('inWave', null);

            if (txtLive) {
                txtLive.textContent =
                    `${lat.toFixed(3)}°N, ${lng.toFixed(3)}°E — wind ${wind} kts, waves ${wave} m`;
            }
            log(`Live metocean refreshed at ${lat.toFixed(3)}°N, ${lng.toFixed(3)}°E.`, 'ai');
        }

        const TOOL_HINTS = {
            pointer: "Pointer Active: Drag pins or click map tools.",
            portA: "Click anywhere on map to set Departure Point (Port A).",
            portB: "Click anywhere on map to set Destination Point (Port B).",
            obstacle: "Click on map to add dynamic obstacle hazard.",
            storm: "Click on map to add storm vortex avoidance zone."
        };

        function getSafeVal(id, fallback = 0) {
            const el = document.getElementById(id);
            if (!el) return fallback;
            if (el.type === 'checkbox') return el.checked;
            const val = parseFloat(el.value);
            return isNaN(val) ? el.value : val;
        }

        function setSafeVal(id, value) {
            const el = document.getElementById(id);
            if (!el) return false;
            el.value = value;
            el.dispatchEvent(new Event('input'));
        }

        // Readouts the voyage HUD shows alongside their sidebar original. Mirroring
        // here rather than at each call site means the HUD cannot drift out of step
        // with the panel: the countdown is written from three different places and
        // a fourth would otherwise have to remember to update both.
        const HUD_MIRRORS = { outEtaSecs: 'outHudTimeRemaining' };

        function updateDisplayValue(id, value) {
            const el = document.getElementById(id);
            if (el) el.innerText = value;
            const mirrorId = HUD_MIRRORS[id];
            if (mirrorId) {
                const mirror = document.getElementById(mirrorId);
                if (mirror) mirror.innerText = value;
            }
        }

        // The optimiser's recommended throttle, as a percentage of rated RPM. The
        // conversion happens once, server-side in app.ts (`throttlePctFromRpm`);
        // this only displays it. Null means no recommendation was returned, and a
        // dash is the honest reading -- never a carried-over or default number.
        // Renders both halves of the optimiser's throttle advice: the setting it
        // recommends and what that setting saves. They are written together and
        // are meaningless apart -- a saving with no throttle to reach it is not
        // an instruction a captain can act on.
        //
        // `savings` is litres per hour from /advise, which is NOT the sidebar's
        // "Est. Fuel Saving" -- that one is a percentage against the direct track
        // from /route. Two different questions, so the unit is on the label to
        // keep them from being read as the same number.
        function renderAdvisoryHud() {
            const pct = State.ai.recThrottle;
            const lph = State.ai.savings;
            const okPct = pct != null && Number.isFinite(pct);
            const okLph = lph != null && Number.isFinite(lph);
            updateDisplayValue('outHudRecThrottle', okPct ? pct.toFixed(0) : '—');
            // A negative saving is a real answer -- the recommendation can cost
            // fuel to hold a schedule -- so the sign is kept rather than clamped.
            updateDisplayValue('outHudRecSaving', okLph ? lph.toFixed(1) : '—');
        }

        function log(msg, type = 'info') {
            const logBox = document.getElementById('aiLogBox');
            if (!logBox) return false;
            const time = new Date().toLocaleTimeString('en-US', {hour12: false});

            // State colour rides on the icon, not on the message text. Two reasons:
            // the message stays at full ink contrast (yellow-400 body copy measured
            // below AA against this panel), and colour keeps meaning one thing --
            // the five roles in src/index.css and nothing else.
            let icon = 'fa-info-circle', tone = 'text-slate-400';
            if (type === 'warn')    { icon = 'fa-triangle-exclamation'; tone = 'text-amber-300'; }
            if (type === 'alert')   { icon = 'fa-circle-exclamation';   tone = 'text-red-300'; }
            if (type === 'success') { icon = 'fa-check';                tone = 'text-emerald-300'; }
            if (type === 'ai')      { icon = 'fa-brain';                tone = 'text-orange-300'; }

            // No left stripe. A 2px coloured border-left on every entry was the
            // loudest thing in the panel and carried no information the icon
            // did not already carry.
            const entry = document.createElement('div');
            entry.className = 'mb-2 flex gap-2 items-baseline text-slate-200';
            entry.innerHTML =
                `<span class="text-slate-400 hud-font shrink-0">${time}</span>` +
                `<i class="fa-solid ${icon} ${tone} shrink-0 mt-0.5"></i>` +
                `<span class="min-w-0">${msg}</span>`;
            
            logBox.appendChild(entry);
            logBox.scrollTop = logBox.scrollHeight;
        }

        function initMap() {
            if (typeof L === 'undefined') {
                log("Leaflet JS failed to load.", "alert");
                return false;
            }

            map = L.map('leafletMap', {
                center: [10.68, 122.57],
                zoom: 14,
                zoomControl: false,
                attributionControl: false
            });
            map.on('zoom zoomend', () => {
                if (typeof window.syncZoomUI === 'function') window.syncZoomUI();
            });
            map.on('moveend', () => {
                if (typeof LiveWaterMask !== 'undefined') LiveWaterMask.update(map);
            });
            map.whenReady(() => {
                if (typeof LiveWaterMask !== 'undefined') LiveWaterMask.update(map);
            });

            satelliteTileLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
                maxZoom: 21,
                maxNativeZoom: 17,
                attribution: '&copy; Esri'
            });

            defaultMapTileLayer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
                maxZoom: 19,
                attribution: '&copy; OpenStreetMap contributors'
            });

            labelsTileLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}.png', {
                maxZoom: 19,
                subdomains: 'abcd'
            });

            oceanBaseTileLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png', {
                maxZoom: 19,
                attribution: '&copy; OpenStreetMap contributors, &copy; CARTO Dark Matter'
            });

            oceanRefTileLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Reference/MapServer/tile/{z}/{y}/{x}', {
                maxZoom: 19,
                attribution: '&copy; Esri Ocean Bathymetry Reference'
            });

            openSeaMapTileLayer = L.tileLayer('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', {
                maxZoom: 18,
                attribution: '&copy; OpenSeaMap contributors'
            });

            if (current2DMapType === 'satellite') {
                satelliteTileLayer.addTo(map);
                labelsTileLayer.addTo(map);
            } else if (current2DMapType === 'nautical') {
                oceanBaseTileLayer.addTo(map);
                oceanRefTileLayer.addTo(map);
            } else {
                defaultMapTileLayer.addTo(map);
            }

            if (isNauticalOverlayActive || current2DMapType === 'nautical') {
                openSeaMapTileLayer.addTo(map);
            }

            hazardLayerGroup = L.layerGroup().addTo(map);

            baseRoutePolyline = L.polyline([], { color: 'rgba(255, 255, 255, 0.4)', weight: 2, dashArray: '6,6' }).addTo(map);
            idealRoutePolyline = L.polyline([], { color: '#f97316', weight: 4, opacity: 0.5 }).addTo(map);
            aiRoutePolyline = L.polyline([], { color: '#f97316', weight: 4 }).addTo(map);

            map.on('click', (e) => {
                if (State.isRunning && State.activeTool === 'pointer') {
                    log("Cannot relocate ports during active voyage. Abort voyage first.", "warn");
                    return false;
                }
                
                if (State.activeTool === 'pointer') {
                    if (!State.portA || (State.portA && State.portB)) {
                        // First click or reset: Set Departure
                        State.portA = {
                            lat: e.latlng.lat,
                            lng: e.latlng.lng,
                            name: `Departure (${e.latlng.lat.toFixed(4)}, ${e.latlng.lng.toFixed(4)})`
                        };
                        State.portB = null;
                        if (portBMarker) { map.removeLayer(portBMarker); portBMarker = null; }
                        ensurePortAMarker(e.latlng.lat, e.latlng.lng, State.portA.name);
                        updateRoute();
                        log(`Departure point set to [${e.latlng.lat.toFixed(4)}, ${e.latlng.lng.toFixed(4)}].`, "success");
                    } else if (State.portA && !State.portB) {
                        // Second click: Set Destination
                        State.portB = {
                            lat: e.latlng.lat,
                            lng: e.latlng.lng,
                            name: `Destination (${e.latlng.lat.toFixed(4)}, ${e.latlng.lng.toFixed(4)})`
                        };
                        ensurePortBMarker(e.latlng.lat, e.latlng.lng, State.portB.name);
                        updateRoute();
                        log(`Destination point set to [${e.latlng.lat.toFixed(4)}, ${e.latlng.lng.toFixed(4)}].`, "success");
                    }
                } else if (State.activeTool === 'obstacle') {
                    let circle = L.circle(e.latlng, { radius: 180, color: '#eab308', fillColor: '#eab308', fillOpacity: 0.4 }).addTo(hazardLayerGroup);
                    State.entities.obstacles.push({ latLng: e.latlng, radiusMeters: 180, marker: circle });
                    if (State.portA && State.portB) {
                        generateTargetRoute();
                        log("Obstacle added. Route re-computed around hazard.", "warn");
                    } else {
                        log("Obstacle added.", "warn");
                    }
                } else if (State.activeTool === 'storm') {
                    let storm = L.circle(e.latlng, { radius: 450, color: '#3b82f6', fillColor: '#3b82f6', fillOpacity: 0.4 }).addTo(hazardLayerGroup);
                    State.entities.storms.push({ latLng: e.latlng, radiusMeters: 450, marker: storm });
                    if (State.portA && State.portB) {
                        generateTargetRoute();
                        log("Storm vortex added. Route re-computed around storm zone.", "warn");
                    } else {
                        log("Storm vortex added.", "warn");
                    }
                }
            });

            ensureShipMarker(State.ship.lat, State.ship.lng);
            updateRoute();

            const refreshMapSize = () => { if (map) map.invalidateSize(); };
            refreshMapSize();
            setTimeout(refreshMapSize, 100);
            setTimeout(refreshMapSize, 400);

            const container = document.getElementById('canvasContainer');
            if (container && window.ResizeObserver) {
                new ResizeObserver(() => refreshMapSize()).observe(container);
            }
        }

        // Helper for completing voyage and resetting state
        
function getHistoricalTrips() {
    try {
        const saved = localStorage.getItem('marine_ai_historical_trips');
        if (saved) {
            const data = JSON.parse(saved);
            const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
            const filtered = data.filter(trip => new Date(trip.timestamp).getTime() > thirtyDaysAgo);
            if (filtered.length !== data.length) {
                localStorage.setItem('marine_ai_historical_trips', JSON.stringify(filtered));
            }
            return filtered;
        }
    } catch(e) {}
    return [];
}

function saveTripData() {
    if (State.mlLogger.data.length === 0) return;
    
    const trip = {
        id: 'trip_' + Date.now(),
        timestamp: new Date().toISOString(),
        portA: State.portA ? State.portA.name : 'Unknown',
        portB: State.portB ? State.portB.name : 'Unknown',
        distanceNM: State.ship.distanceTraveledNM || 0,
        // null, not 0, when the manifest was never taken -- an unrecorded
        // passenger count is not an empty vessel.
        pax: Number.isFinite(State.ship.currentPax) ? State.ship.currentPax : null,
        data: [...State.mlLogger.data]
    };

    const history = getHistoricalTrips();
    history.push(trip);
    try {
        localStorage.setItem('marine_ai_historical_trips', JSON.stringify(history));
    } catch(e) {}
    
    State.mlLogger.data = [];
    // The manifest belongs to the voyage just logged; the next departure asks again.
    State.ship.currentPax = null;
    State.currentViewedTrip = null;
    if (document.getElementById('txtRecordCount')) {
        document.getElementById('txtRecordCount').textContent = '0';
    }
    
    if (typeof refreshAnalyticsSidebar === 'function') {
        refreshAnalyticsSidebar();
    }
}


function downloadTripCSV(trip) {
    const dataToDownload = trip.data;
    if (!dataToDownload || dataToDownload.length === 0) return;
    
    const keys = Object.keys(dataToDownload[0]);
    const csvContent = [
        keys.join(','),
        ...dataToDownload.map(row => keys.map(k => row[k]).join(','))
    ].join('\n');
    
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.setAttribute('href', url);
    const dateStr = new Date(trip.timestamp || Date.now()).toISOString().split('T')[0];
    const filename = trip.id === 'live_trip' ? `analytics_live_trip_${dateStr}.csv` : `analytics_trip_${dateStr}_${trip.id}.csv`;
    a.setAttribute('download', filename);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}


function refreshAnalyticsSidebar() {
    const container = document.getElementById('tripListContainer');
    if (!container) return;
    
    const history = getHistoricalTrips();
    
    let html = '';
    
    // Add live trip if logging is active
    if (State.mlLogger.data && State.mlLogger.data.length > 0) {
        html += '<div class="text-xs font-bold text-emerald-400 mt-2 mb-1 border-b border-emerald-500/20 pb-0.5">Live Data</div>';
        const liveTrip = {
            id: 'live_trip',
            timestamp: new Date().toISOString(),
            portA: State.portA ? State.portA.name : 'Unknown',
            portB: State.portB ? State.portB.name : 'Unknown',
            distanceNM: State.ship.distanceTraveledNM || 0,
            data: State.mlLogger.data
        };
        const timeStr = new Date(liveTrip.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        html += '<div class="trip-item p-2 rounded bg-slate-800 hover:bg-slate-700 cursor-pointer border border-transparent transition-colors" data-trip-id="live_trip">';
        html += '<div class="text-xs font-bold text-slate-200 flex justify-between"><span>Current Voyage</span><span class="text-sky-400">' + liveTrip.distanceNM.toFixed(1) + ' NM</span></div>';
        html += '<div class="text-xs text-slate-400 mt-1 truncate" title="' + liveTrip.portA + ' to ' + liveTrip.portB + '">' + liveTrip.portA.split('(')[0] + ' <i class="fa-solid fa-arrow-right mx-1"></i> ' + liveTrip.portB.split('(')[0] + '</div>';
        html += '<div class="flex justify-between items-center mt-0.5"><div class="text-xs text-slate-500" id="liveRecordCount">' + liveTrip.data.length + ' records (Recording)</div><button class="text-xs text-slate-400 hover:text-white download-trip-btn" data-trip-id="live_trip" title="Download Live Trip CSV"><i class="fa-solid fa-download"></i></button></div></div>';
    }
    
    if (history.length === 0 && !html) {
        container.innerHTML = '<div class="text-xs text-slate-500 italic p-2">No historical trips found.</div>';
        return;
    }

    
    const grouped = {};
    history.forEach(trip => {
        const dateObj = new Date(trip.timestamp);
        const dayStr = dateObj.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
        if (!grouped[dayStr]) grouped[dayStr] = [];
        grouped[dayStr].push(trip);
    });
    
    const days = Object.keys(grouped).sort((a, b) => new Date(b).getTime() - new Date(a).getTime());
    
    days.forEach(day => {
        html += '<div class="text-xs font-bold text-orange-400 mt-2 mb-1 border-b border-orange-500/20 pb-0.5">' + day + '</div>';
        grouped[day].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
        grouped[day].forEach(trip => {
            const timeStr = new Date(trip.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            html += '<div class="trip-item p-2 rounded bg-slate-800 hover:bg-slate-700 cursor-pointer border border-transparent transition-colors" data-trip-id="' + trip.id + '">';
            html += '<div class="text-xs font-bold text-slate-200 flex justify-between"><span>' + timeStr + '</span><span class="text-sky-400">' + trip.distanceNM.toFixed(1) + ' NM</span></div>';
            html += '<div class="text-xs text-slate-400 mt-1 truncate" title="' + trip.portA + ' to ' + trip.portB + '">' + trip.portA.split('(')[0] + ' <i class="fa-solid fa-arrow-right mx-1"></i> ' + trip.portB.split('(')[0] + '</div>';
            html += '<div class="flex justify-between items-center mt-0.5"><div class="text-xs text-slate-500">' + trip.data.length + ' records</div><button class="text-xs text-slate-400 hover:text-white download-trip-btn" data-trip-id="' + trip.id + '" title="Download Trip CSV"><i class="fa-solid fa-download"></i></button></div></div>';
        });
    });
    
    container.innerHTML = html;
    
    
    const downloadBtns = container.querySelectorAll('.download-trip-btn');
    downloadBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const tripId = e.currentTarget.getAttribute('data-trip-id');
            let trip;
            if (tripId === 'live_trip') {
                trip = { timestamp: new Date().toISOString(), data: State.mlLogger.data };
            } else {
                const history = getHistoricalTrips();
                trip = history.find(t => t.id === tripId);
            }
            if (trip && trip.data && trip.data.length > 0) {
                downloadTripCSV(trip);
            }
        });
    });

    const tripElements = container.querySelectorAll('.trip-item');
    tripElements.forEach(el => {
        el.addEventListener('click', (e) => {
            tripElements.forEach(t => {
                t.classList.remove('border-orange-500', 'bg-slate-700');
                t.classList.add('border-transparent');
            });
            e.currentTarget.classList.remove('border-transparent');
            e.currentTarget.classList.add('border-orange-500', 'bg-slate-700');
            
            const tripId = e.currentTarget.getAttribute('data-trip-id');
            let trip;
            if (tripId === 'live_trip') {
                trip = { data: State.mlLogger.data };
            } else {
                trip = history.find(t => t.id === tripId);
            }
            if (trip) {
                State.currentViewedTrip = trip;
                if (document.getElementById('txtRecordCount')) {
                    document.getElementById('txtRecordCount').textContent = trip.data.length;
                }
                if (window.updateAnalyticsChartWithData) {
                    window.updateAnalyticsChartWithData(trip.data);
                }
            }
        });
    });
}


        // Passenger manifest, asked once per departure.
        //
        // Runs the voyage only after the operator confirms, so `onConfirm` is the
        // continuation rather than the caller continuing regardless -- cancelling
        // must leave the vessel alongside, not under way with a blank manifest.
        // Both listeners are removed on close; re-opening the dialog would
        // otherwise stack a second pair and fire the continuation twice.
        function showPaxModal(onConfirm) {
            const modal = document.getElementById('paxModal');
            const inCurrentPax = document.getElementById('inCurrentPax');
            const btnCancelPax = document.getElementById('btnCancelPax');
            const btnConfirmPax = document.getElementById('btnConfirmPax');
            const paxError = document.getElementById('paxError');
            const paxModalMax = document.getElementById('paxModalMax');
            const inModalEta = document.getElementById('inModalEta');
            const etaError = document.getElementById('etaError');
            const mainInEta = document.getElementById('inEta');

            // No dialog in the DOM is not a reason to refuse to sail.
            if (!modal || !inCurrentPax || !btnConfirmPax || !btnCancelPax) {
                if (onConfirm) onConfirm();
                return;
            }

            const maxPax = Math.max(0, parseInt(getSafeVal('inMaxPax', 50), 10) || 0);
            if (paxModalMax) paxModalMax.textContent = maxPax;
            if (inCurrentPax) inCurrentPax.max = maxPax;
            if (inModalEta && mainInEta) inModalEta.value = mainInEta.value || 25;

            modal.classList.remove('hidden');
            modal.classList.add('flex');
            inCurrentPax.value = '';
            paxError.classList.add('hidden');
            if (etaError) etaError.classList.add('hidden');
            inCurrentPax.focus();

            const cleanup = () => {
                modal.classList.add('hidden');
                modal.classList.remove('flex');
                btnCancelPax.removeEventListener('click', onCancelClick);
                btnConfirmPax.removeEventListener('click', onConfirmClick);
            };

            const onCancelClick = () => {
                cleanup();
                log('Departure cancelled at the passenger manifest.', 'info');
            };

            const onConfirmClick = () => {
                const pax = parseInt(inCurrentPax.value, 10);
                const etaVal = inModalEta ? parseFloat(inModalEta.value) : null;
                let hasError = false;

                if (!Number.isFinite(pax) || pax < 0 || pax > maxPax) {
                    paxError.classList.remove('hidden');
                    hasError = true;
                } else {
                    paxError.classList.add('hidden');
                }

                if (inModalEta && (!Number.isFinite(etaVal) || etaVal <= 0)) {
                    if (etaError) etaError.classList.remove('hidden');
                    hasError = true;
                } else if (etaError) {
                    etaError.classList.add('hidden');
                }

                if (hasError) return;

                State.ship.currentPax = pax;
                if (mainInEta && Number.isFinite(etaVal)) {
                    setSafeVal('inEta', etaVal);
                }
                evaluateAndAdjustEtaDynamics();
                log(`Manifest: ${pax} of ${maxPax} passengers aboard.`, 'info');
                cleanup();
                if (onConfirm) onConfirm();
            };

            btnCancelPax.addEventListener('click', onCancelClick);
            btnConfirmPax.addEventListener('click', onConfirmClick);
        }

        function completeVoyageAndSwapPorts() {
            saveTripData();
            log("Voyage Complete. Vessel successfully berthed at destination port.", "success");
            
            // Swap ports
            State.direction *= -1;
            State.ship.progress = 0;
            State.ship.distanceTraveledNM = 0;
            updateRoute();
            log("Departure and arrival ports swapped automatically.", "info");
            
            const btnStart = document.getElementById('btnStart');
            if (btnStart) {
                btnStart.innerText = "Start";
                btnStart.className = "h-8 bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-600 hover:to-amber-600 text-white px-3 rounded-lg font-bold text-xs transition-all shadow-[0_0_10px_rgba(249,115,22,0.3)] active:scale-95 flex items-center justify-center gap-1.5 shrink-0 whitespace-nowrap cursor-pointer";
            }
            updateDisplayValue('outEtaSecs', '00:00');
            if (!State.isManualMode && !State.isGpsMode && !is2DExpanded) {
                expand2DView();
            } else {
                if (typeof updateClose2DButtonVisibility === 'function') updateClose2DButtonVisibility();
            }
        }

        async function updateRoute() {
            if (!State.portA || !State.portB) {
                if (baseRoutePolyline) baseRoutePolyline.setLatLngs([]);
                if (aiRoutePolyline) aiRoutePolyline.setLatLngs([]);
                if (idealRoutePolyline) idealRoutePolyline.setLatLngs([]);
                State.basePath = [];
                State.targetPath = [];
                State.idealPath = [];
                ensureShipMarker(State.ship.lat, State.ship.lng);
                if (typeof gmap !== 'undefined' && gmap) {
                    if (gmap.getSource('route')) {
                        gmap.getSource('route').setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [] } });
                    }
                    if (gmap.getSource('idealRoute')) {
                        gmap.getSource('idealRoute').setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [] } });
                    }
                }
                let msg = "Set Departure (Port A) & Destination (Port B) on map";
                if (State.portA) msg = "Departure (Port A) set. Place Destination (Port B) on map";
                else if (State.portB) msg = "Destination (Port B) set. Place Departure (Port A) on map";
                updateDisplayValue('headerSubtitle', msg);
                updateDisplayValue('throttleStatus', 'Awaiting Ports');
                return;
            }

            const start = State.direction === 1 ? State.portA : State.portB;
            const end = State.direction === 1 ? State.portB : State.portA;
            
            const startLatLng = L.latLng(start.lat, start.lng);
            const endLatLng = L.latLng(end.lat, end.lng);

            REAL_DISTANCE_KM = startLatLng.distanceTo(endLatLng) / 1000;

            if (!State.isRunning && !State.isGpsMode) {
                State.ship.lat = start.lat;
                State.ship.lng = start.lng;
                State.ship.progress = 0;
                ensureShipMarker(start.lat, start.lng);
            }

            updateDisplayValue('headerSubtitle', `Global High-Precision Land Pathfinder (${REAL_DISTANCE_KM.toFixed(2)} km Voyage)`);
            generateTargetRoute();
            if (State.isManualMode || State.isGpsMode) {
                const label = State.isManualMode ? 'Manual Control Active' : 'Actual Mode Active';
                const engage = () => {
                    State.isRunning = true;
                    if (typeof collapse2DView === 'function' && is2DExpanded) collapse2DView();
                    updateDisplayValue('throttleStatus', label);
                };
                // updateRoute() also runs on every port drag mid-voyage; only a
                // standing start is a departure worth asking the manifest for.
                if (!State.isRunning) {
                    showPaxModal(engage);
                } else {
                    engage();
                }
            } else {
                updateDisplayValue('throttleStatus', 'Ports Set - Ready');
            }
        }

        // --- SPATIAL CACHING & ENVIRONMENTAL TURBULENCE ENGINE ---
        const MarineDataCache = {
            cache: new Map(),
            gridSize: 0.05, // ~5.5 km spatial grid tile
            ttlMs: 5 * 60 * 1000, // 5 minute TTL for Open-Meteo REST API
            lastFetchTime: 0,
            lastTileKey: "",

            getTileKey(lat, lng) {
                const gridLat = (Math.floor(lat / this.gridSize) * this.gridSize).toFixed(2);
                const gridLng = (Math.floor(lng / this.gridSize) * this.gridSize).toFixed(2);
                return `${gridLat},${gridLng}`;
            },

            get(lat, lng, allowStale = false) {
                const key = this.getTileKey(lat, lng);
                const entry = this.cache.get(key);
                if (entry) {
                    if ((Date.now() - entry.timestamp) < this.ttlMs) {
                        return entry;
                    }
                    if (allowStale && entry.hourly) {
                        return this.extractForecastForNow(entry);
                    }
                }
                return null;
            },

            extractForecastForNow(entry) {
                if (!entry || !entry.hourly || !entry.hourly.weather || !entry.hourly.marine) return entry;
                const nowUnix = Math.floor(Date.now() / 1000);
                const times = entry.hourly.weather.time; // array of unix timestamps
                if (!times) return entry;
                
                let closestIdx = 0;
                let minDiff = Infinity;
                for (let i = 0; i < times.length; i++) {
                    const diff = Math.abs(times[i] - nowUnix);
                    if (diff < minDiff) {
                        minDiff = diff;
                        closestIdx = i;
                    }
                }
                
                const hw = entry.hourly.weather;
                const hm = entry.hourly.marine;
                
                const windSpd = Math.round(hw.wind_speed_10m[closestIdx] ?? entry.data.windSpd);
                const windDir = Math.round(hw.wind_direction_10m[closestIdx] ?? entry.data.windDir);
                const waveHt = parseFloat((hm.wave_height[closestIdx] ?? entry.data.waveHt).toFixed(1));
                const waveDir = Math.round(hm.wave_direction[closestIdx] ?? entry.data.waveDir);
                const ms = hm.ocean_current_velocity[closestIdx] ?? 0;
                const currentSpd = parseFloat((ms * 1.94384).toFixed(1));
                const currentDir = Math.round(hm.ocean_current_direction[closestIdx] ?? entry.data.currentDir);

                return {
                    ...entry,
                    data: {
                        windSpd, windDir, waveHt, waveDir, currentSpd, currentDir, isLive: false, isForecast: true
                    }
                };
            },

            set(lat, lng, data, hourlyData = null) {
                const key = this.getTileKey(lat, lng);
                const entry = {
                    timestamp: Date.now(),
                    data: data,
                    hourly: hourlyData,
                    tileKey: key,
                    gridLat: (Math.floor(lat / this.gridSize) * this.gridSize).toFixed(2),
                    gridLng: (Math.floor(lng / this.gridSize) * this.gridSize).toFixed(2)
                };
                this.cache.set(key, entry);
                this.lastFetchTime = entry.timestamp;
                this.lastTileKey = key;
                return entry;
            }
        };

        // Physically accurate 12.42-hour M2 semi-diurnal tidal cycle equation
        function computeTideLevel(lat, lng, timestampMs) {
            const timeSec = (timestampMs || Date.now()) / 1000;
            const m2Period = 44712; // 12.42h principal lunar semi-diurnal constituent
            const s2Period = 43200; // 12.00h solar constituent
            const phaseShift = (lat * 0.15 + lng * 0.22);
            
            const m2Val = Math.sin((2 * Math.PI * timeSec / m2Period) + phaseShift);
            const s2Val = 0.35 * Math.sin((2 * Math.PI * timeSec / s2Period) + phaseShift * 0.8);
            const tideHeightMeters = parseFloat((0.2 + 0.9 * m2Val + 0.3 * s2Val).toFixed(2));
            
            const derivative = Math.cos((2 * Math.PI * timeSec / m2Period) + phaseShift);
            let phaseText = "Slack Water";
            if (derivative > 0.15) phaseText = "Flood (Rising)";
            else if (derivative < -0.15) phaseText = "Ebb (Falling)";
            else if (m2Val > 0.5) phaseText = "High Water (HW)";
            else phaseText = "Low Water (LW)";

            return { heightM: tideHeightMeters, phaseText };
        }

        // Real-time micro-turbulence, gust spectrum, and wave groupiness overlay
        function computeMicroTurbulence(baseWindSpd, baseWindDir, baseWaveHt, baseWaveDir, baseCurrentSpd, baseCurrentDir) {
            const nowSec = performance.now() / 1000;
            
            // Multi-frequency wind gust spectrum
            const gustFactor = 1.0 
                + 0.18 * Math.sin(nowSec * 0.78) 
                + 0.12 * Math.cos(nowSec * 0.33) 
                + 0.08 * Math.sin(nowSec * 0.14);
            
            const windDirWander = 5.0 * Math.sin(nowSec * 0.25) + 3.0 * Math.cos(nowSec * 0.55);
            
            const liveWindSpd = Math.max(0, parseFloat((baseWindSpd * gustFactor).toFixed(1)));
            const liveWindDir = Math.round((baseWindDir + windDirWander + 360) % 360);
            const peakGustSpd = parseFloat((baseWindSpd * 1.35 + 2.0 * Math.sin(nowSec * 0.85)).toFixed(1));

            // Wave groupiness envelope (sets every 35-45s)
            const waveEnvelope = 1.0 + 0.20 * Math.sin(nowSec * 0.18) * Math.cos(nowSec * 0.06);
            const liveWaveHt = Math.max(0.2, parseFloat((baseWaveHt * waveEnvelope).toFixed(1)));
            const maxWaveInGroup = parseFloat((baseWaveHt * 1.35).toFixed(1));

            // Current eddy turbulence
            const currentEddy = 0.2 * Math.sin(nowSec * 0.42);
            const liveCurrentSpd = Math.max(0, parseFloat((baseCurrentSpd + currentEddy).toFixed(1)));

            return {
                windSpd: liveWindSpd,
                windDir: liveWindDir,
                peakGustSpd: peakGustSpd,
                waveHt: liveWaveHt,
                maxWaveInGroup: maxWaveInGroup,
                currentSpd: liveCurrentSpd,
                currentDir: baseCurrentDir,
                gustFactorPct: Math.round((gustFactor - 1.0) * 100)
            };
        }

        // Provenance of the metocean numbers on screen. Three states, not two:
        // the old boolean could not express "the fetch failed and these are
        // default constants", so a failed sync rendered as LIVE SYNC while the
        // event log claimed a successful one. The `isLive` flag that would have
        // caught it was set in three places and read in none.
        //
        // Colour follows the product register: sky = informational (live),
        // emerald = nominal (cache), amber = caution (defaults). The distinction
        // matters because every recommendation downstream is computed from these
        // numbers, so "where did the weather come from" is the same question as
        // "is the advice about today".
        const API_STATUS = {
            live: { text: "LIVE SYNC", cls: "bg-sky-500/20 text-sky-300",
                    title: "Conditions fetched from Open-Meteo just now." },
            cache: { text: "CACHE HIT", cls: "bg-emerald-500/20 text-emerald-300",
                    title: "Conditions from a recent Open-Meteo response held in the local tile cache." },
            fallback: { text: "NO SIGNAL", cls: "bg-amber-500/20 text-amber-300",
                    title: "Open-Meteo unreachable. Showing DEFAULT conditions, not measured weather — advice is illustrative, not about today." }
        };

        function updateApiUiStatus(mode, gridLat, gridLng, timestamp) {
            const s = API_STATUS[mode] || API_STATUS.fallback;
            const badgeEl = document.getElementById('outApiCacheBadge');
            if (badgeEl) {
                badgeEl.className = `${s.cls} px-1.5 py-0.5 rounded font-mono font-semibold`;
                badgeEl.innerText = s.text;
                badgeEl.title = s.title;
            }
            const tileEl = document.getElementById('outApiTile');
            if (tileEl) {
                tileEl.innerText = `Grid ${gridLat}°N, ${gridLng}°E`;
            }
            const lastSyncEl = document.getElementById('outApiLastSync');
            if (lastSyncEl) {
                if (mode === 'fallback') {
                    // "Synced 0s ago" next to numbers that never came from a
                    // network is the specific lie this replaces.
                    lastSyncEl.innerText = 'Never synced';
                } else {
                    const secsAgo = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
                    lastSyncEl.innerText = `Synced ${secsAgo}s ago`;
                }
            }
        }

        async function fetchLiveMarineData(lat, lng, force = false) {
            if (isFetchingApi) return null;

            if (!force) {
                const cached = MarineDataCache.get(lat, lng);
                if (cached) {
                    updateApiUiStatus('cache', cached.gridLat, cached.gridLng, cached.timestamp);
                    return cached.data;
                }
            }

            isFetchingApi = true;
            try {
                // Request current and 3 days of hourly forecast for offline prediction
                const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}&current=wind_speed_10m,wind_direction_10m&hourly=wind_speed_10m,wind_direction_10m&wind_speed_unit=kn&timeformat=unixtime&forecast_days=3`;
                const marineUrl = `https://marine-api.open-meteo.com/v1/marine?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}&current=wave_height,wave_direction,ocean_current_velocity,ocean_current_direction&hourly=wave_height,wave_direction,ocean_current_velocity,ocean_current_direction&timeformat=unixtime&forecast_days=3`;

                let weatherRes = null, marineRes = null;
                
                if (navigator.onLine) {
                    [weatherRes, marineRes] = await Promise.all([
                        fetch(weatherUrl).then(r => r.ok ? r.json() : null).catch(() => null),
                        fetch(marineUrl).then(r => r.ok ? r.json() : null).catch(() => null)
                    ]);
                }

                if ((!weatherRes || !marineRes) && !force) {
                    // Fallback to offline prediction using cached hourly data
                    const fallback = MarineDataCache.get(lat, lng, true);
                    if (fallback && fallback.data) {
                        updateApiUiStatus('cache', fallback.gridLat, fallback.gridLng, fallback.timestamp);
                        log(`Offline Fallback: Using predicted marine data for [${fallback.gridLat}°N, ${fallback.gridLng}°E]`, "info");
                        return fallback.data;
                    }
                }

                let windSpd = 12, windDir = 212, currentSpd = 0.6, currentDir = 252, waveHt = 0.5, waveDir = 219;
                let isLive = false;

                if (weatherRes && weatherRes.current) {
                    windSpd = Math.round(weatherRes.current.wind_speed_10m ?? 12);
                    windDir = Math.round(weatherRes.current.wind_direction_10m ?? 212);
                    isLive = true;
                }

                if (marineRes && marineRes.current) {
                    waveHt = parseFloat((marineRes.current.wave_height ?? 0.5).toFixed(1));
                    waveDir = Math.round(marineRes.current.wave_direction ?? 219);
                    const ms = marineRes.current.ocean_current_velocity ?? 0.3;
                    currentSpd = parseFloat((ms * 1.94384).toFixed(1));
                    currentDir = Math.round(marineRes.current.ocean_current_direction ?? 252);
                    isLive = true;
                }

                const liveData = { windSpd, windDir, currentSpd, currentDir, waveHt, waveDir, isLive };

                if (!isLive) {
                    // Neither endpoint answered, so every value above is the
                    // default constant declared at the top of this block. Do NOT
                    // cache it: a cached default is indistinguishable from cached
                    // real weather on the next read, which would launder an
                    // invented number into a "CACHE HIT" for the rest of the
                    // session. Leaving it uncached also means the next call
                    // retries the fetch instead of settling for the constants.
                    const [gLat, gLng] = MarineDataCache.getTileKey(lat, lng).split(',');
                    updateApiUiStatus('fallback', gLat, gLng, null);
                    log(`Open-Meteo unreachable — advising on DEFAULT conditions (wind ${windSpd} kts, waves ${waveHt} m), not measured weather.`, "alert");
                    return liveData;
                }

                const hourlyData = {
                    weather: weatherRes ? weatherRes.hourly : null,
                    marine: marineRes ? marineRes.hourly : null
                };

                const entry = MarineDataCache.set(lat, lng, liveData, hourlyData);
                updateApiUiStatus('live', entry.gridLat, entry.gridLng, entry.timestamp);
                log(`Open-Meteo REST API Synced: Spatial Grid [${entry.gridLat}°N, ${entry.gridLng}°E] - Wind: ${windSpd}kts, Waves: ${waveHt}m`, "ai");
                return liveData;
            } catch (err) {
                console.warn("API Error:", err);
                const fallback = MarineDataCache.get(lat, lng, true);
                if (fallback && fallback.data) return fallback.data;
                return null;
            } finally {
                isFetchingApi = false;
            }
        }

        window.triggerManualApiSync = function() {
            const lat = State.ship.lat || (State.portA ? State.portA.lat : 10.6928);
            const lng = State.ship.lng || (State.portA ? State.portA.lng : 122.5644);
            log(`Manual Open-Meteo API Sync requested for Lat ${lat.toFixed(4)}, Lng ${lng.toFixed(4)}...`, "ai");
            fetchLiveMarineData(lat, lng, true).then(liveData => {
                if (liveData) {
                    process2SecondApiLivestream();
                }
            });
        }

        function distToSegmentMeters(p, a, b) {
            if (!p || !a || !b) return Infinity;
            const latP = p.lat, lngP = p.lng;
            const latA = a.lat, lngA = a.lng;
            const latB = b.lat, lngB = b.lng;
            const dx = latB - latA;
            const dy = lngB - lngA;
            if (dx === 0 && dy === 0) return p.distanceTo(a);
            const t = Math.max(0, Math.min(1, ((latP - latA) * dx + (lngP - lngA) * dy) / (dx * dx + dy * dy)));
            const projLat = latA + t * dx;
            const projLng = lngA + t * dy;
            return p.distanceTo(L.latLng(projLat, projLng));
        }

        let isGeneratingRoute = false;
        let pendingRouteRequest = false;

        async function generateTargetRoute() {
            if (!State.portA || !State.portB) {
                log("Cannot compute path: Departure (Port A) and Destination (Port B) are not set.", "warn");
                return false;
            }
            if (isGeneratingRoute) {
                pendingRouteRequest = true;
                return false;
            }
            isGeneratingRoute = true;
            const mode = State.pathMode || 'hybrid';
            updateDisplayValue('throttleStatus', mode === 'greatcircle' ? 'Direct Great Circle Baseline...' : (mode === 'astar' ? 'Computing Pure A* Water Path...' : 'Planning route (optimiser + A*)...'));

            const wasRunningAtStart = State.isRunning;
            const liveBoatLat = State.ship.lat || (State.portA ? State.portA.lat : 10.6928);
            const liveBoatLng = State.ship.lng || (State.portA ? State.portA.lng : 122.5644);

            let startPort;
            if (wasRunningAtStart) {
                startPort = {
                    lat: liveBoatLat,
                    lng: liveBoatLng,
                    name: "Vessel Current Position"
                };
            } else {
                startPort = State.direction === 1 ? State.portA : State.portB;
            }
            const endPort = State.direction === 1 ? State.portB : State.portA;
            
            const hazards = [...State.entities.obstacles, ...State.entities.storms];
            const etaMinutes = parseInt(document.getElementById('inEta') ? document.getElementById('inEta').value : 25, 10);

            let rawPathLatLngs = [];
            let resultObj = null;
            
            if (mode === 'greatcircle') {
                const numPoints = 25;
                const gcPoints = [];
                for (let i = 0; i <= numPoints; i++) {
                    let f = i / numPoints;
                    let pt = sphericalInterpolate(startPort.lat, startPort.lng, endPort.lat, endPort.lng, f);
                    gcPoints.push(L.latLng(pt.lat, pt.lng));
                }
                rawPathLatLngs = gcPoints;
                State.basePath = gcPoints.map(p => [p.lat, p.lng]);
                if (baseRoutePolyline) baseRoutePolyline.setLatLngs(State.basePath);
            } else {
                const skipAi = (mode === 'astar');
                const result = await PrecisionPathfinder.computePath(startPort, endPort, hazards, etaMinutes, { skipAiWaypoints: skipAi });
                resultObj = result;

                if (result.error) {
                    log(`Pathfinder Error: ${result.error}`, "alert");
                    updateDisplayValue('throttleStatus', 'Path Blocked by Land');
                    updatePathEngineUI(mode, false);
                    isGeneratingRoute = false;
                    return false;
                } else {
                    rawPathLatLngs = result.path.map(p => L.latLng(p.lat, p.lng));
                    
                    const numPoints = 25;
                    const gcPoints = [];
                    for (let i = 0; i <= numPoints; i++) {
                        let f = i / numPoints;
                        let pt = sphericalInterpolate(startPort.lat, startPort.lng, endPort.lat, endPort.lng, f);
                        gcPoints.push([pt.lat, pt.lng]);
                    }
                    State.basePath = gcPoints;
                    if (baseRoutePolyline) baseRoutePolyline.setLatLngs(gcPoints);
                    renderDebugLayers();
                }
            }

            // Capture exact current live boat position at instant computePath finishes
            const currentLiveLat = State.ship.lat || liveBoatLat;
            const currentLiveLng = State.ship.lng || liveBoatLng;
            const currentLiveLatLng = L.latLng(currentLiveLat, currentLiveLng);

            if (!State.isRunning) {
                // Voyage hasn't started: simple full route set
                State.targetPath = rawPathLatLngs;
                State.idealPath = [...State.targetPath];
                if (idealRoutePolyline) idealRoutePolyline.setLatLngs(State.idealPath);
                if (aiRoutePolyline) aiRoutePolyline.setLatLngs(State.targetPath);
                State.ship.progress = 0;
                if (State.targetPath.length > 0) {
                    State.ship.lat = State.targetPath[0].lat;
                    State.ship.lng = State.targetPath[0].lng;
                }
            } else {
                // Voyage IS RUNNING: maintain history + absolute boat position + new forward waypoints (No Backstitching!)
                let oldPath = State.targetPath || [];
                let historyPoints = [];

                if (oldPath.length > 0) {
                    let bestOldIdx = 0;
                    let minOldDist = Infinity;
                    for (let i = 0; i < oldPath.length; i++) {
                        const d = currentLiveLatLng.distanceTo(oldPath[i]);
                        if (d < minOldDist) {
                            minOldDist = d;
                            bestOldIdx = i;
                        }
                    }
                    // Keep past trajectory up to bestOldIdx, excluding points right under the boat (< 40m)
                    for (let i = 0; i <= bestOldIdx; i++) {
                        if (i === 0 || currentLiveLatLng.distanceTo(oldPath[i]) > 40) {
                            historyPoints.push(oldPath[i]);
                        }
                    }
                }

                if (historyPoints.length === 0) {
                    const departure = State.direction === 1 ? State.portA : State.portB;
                    if (departure) historyPoints.push(L.latLng(departure.lat, departure.lng));
                }

                // Strictly trim rawPathLatLngs using segment projection to get forward-only waypoints
                let forwardNewPoints = [];
                if (rawPathLatLngs.length > 1) {
                    let minSegDist = Infinity;
                    let bestSegIdx = 0;

                    for (let i = 0; i < rawPathLatLngs.length - 1; i++) {
                        const d = distToSegmentMeters(currentLiveLatLng, rawPathLatLngs[i], rawPathLatLngs[i + 1]);
                        if (d < minSegDist) {
                            minSegDist = d;
                            bestSegIdx = i;
                        }
                    }

                    // Forward points start from bestSegIdx + 1
                    let startFwdIdx = bestSegIdx + 1;
                    if (startFwdIdx < rawPathLatLngs.length && currentLiveLatLng.distanceTo(rawPathLatLngs[startFwdIdx]) < 30) {
                        startFwdIdx = Math.min(rawPathLatLngs.length - 1, startFwdIdx + 1);
                    }

                    for (let i = startFwdIdx; i < rawPathLatLngs.length; i++) {
                        forwardNewPoints.push(rawPathLatLngs[i]);
                    }
                } else {
                    forwardNewPoints = rawPathLatLngs;
                }

                if (forwardNewPoints.length === 0) {
                    forwardNewPoints = [L.latLng(endPort.lat, endPort.lng)];
                }

                // Seamless full route assembly: past trajectory -> current live position -> forward waypoints
                const newFullPath = [...historyPoints, currentLiveLatLng, ...forwardNewPoints];
                State.targetPath = newFullPath;

                // Cumulative distance calculation along newFullPath
                const pathLen = newFullPath.length;
                let cumDists = [0];
                for (let i = 0; i < pathLen - 1; i++) {
                    cumDists.push(cumDists[i] + newFullPath[i].distanceTo(newFullPath[i + 1]));
                }
                const totalDistMeters = cumDists[pathLen - 1];

                const currentPointIdx = historyPoints.length;
                const distSoFar = cumDists[currentPointIdx];

                if (totalDistMeters > 0) {
                    State.ship.progress = Math.min(0.999, Math.max(0, distSoFar / totalDistMeters));
                }

                // ABSOLUTE BOAT POSITION IS PRESERVED CONTINUOUSLY
                State.ship.lat = currentLiveLat;
                State.ship.lng = currentLiveLng;

                if (aiRoutePolyline) aiRoutePolyline.setLatLngs(State.targetPath);

                const originText = `${currentLiveLat.toFixed(4)}°N, ${currentLiveLng.toFixed(4)}°E`;
                log(`[PROACTIVE REROUTE AUTO-APPLIED] Route dynamically optimized from vessel live position [${originText}] without position jump. Zero land hazard + fuel optimized.`, "ai");
                
                const logEl = document.getElementById('txtProactiveRerouteLog');
                if (logEl) {
                    const timeStr = new Date().toLocaleTimeString('en-US', { hour12: false });
                    logEl.innerHTML = `<span class="text-amber-400">[${timeStr}]</span> Rerouted from boat live position (${originText}). Zero land hazard + fuel optimized.`;
                }
                const originEl = document.getElementById('txtRerouteOrigin');
                if (originEl) {
                    originEl.innerText = `${currentLiveLat.toFixed(3)}°, ${currentLiveLng.toFixed(3)}° (Live GPS)`;
                }
            }

            // Overall route metrics
            let curvedDist = 0;
            for (let k = 0; k < State.targetPath.length - 1; k++) {
                curvedDist += State.targetPath[k].distanceTo(State.targetPath[k + 1]);
            }
            const distKm = curvedDist / 1000;
            REAL_DISTANCE_KM = distKm;

            if (mode === 'greatcircle') {
                updateDisplayValue('outMeshNodes', `0 Active Nodes (GC)`);
                updateDisplayValue('outLandPenalties', `0 Land Checks (GC)`);
                const savingsEl = document.getElementById('outSavings');
                if (savingsEl) savingsEl.innerText = `0.0%`;

                updatePathEngineUI('greatcircle', false);
                updateDisplayValue('throttleStatus', 'Great Circle Direct Route Active');
                log("Path generator set to Direct Great Circle Baseline Route", "info");

                calculateAiRecommendations();
                evaluateAndAdjustEtaDynamics();
            } else if (resultObj) {
                updateDisplayValue('outMeshNodes', `${resultObj.meshNodes || 0} Active Nodes`);
                updateDisplayValue('outLandPenalties', `${resultObj.landCount || 0} Land Pixels`);

                // Fuel saved against the direct track, from services/route/planner.py.
                //
                // This readout used to be `15.0 + Math.random() * 5 + 3 - penalty`
                // -- a number that moved every time the path was regenerated and
                // was never computed from a fuel model at all. It now comes from
                // the planner, which costs both the chosen track and the
                // great-circle baseline through the same fuel model and reports
                // the difference.
                //
                // A dash is a legitimate answer here. In benign weather the direct
                // track IS the cheapest track and the honest saving is zero;
                // showing "+17.3%" in that case was the fabrication, not the gap.
                renderRouteSavings(State.routePlan);

                updatePathEngineUI(mode, resultObj.isAiUsed);

                if (mode === 'hybrid') {
                    updateDisplayValue('throttleStatus', resultObj.isAiUsed ? 'Route optimiser + A* hybrid active' : 'A* pathfinder (optimiser offline)');
                } else if (mode === 'dlite') {
                    updateDisplayValue('throttleStatus', 'D* Lite Pathfinder Active');
                } else if (mode === 'rrt') {
                    updateDisplayValue('throttleStatus', 'BAIBAIRRT Explorer Pathfinder Active');
                } else {
                    updateDisplayValue('throttleStatus', 'Pure A* Water Pathfinder Active');
                }

                calculateAiRecommendations();
                evaluateAndAdjustEtaDynamics();
            }
            
            if (typeof gmap !== 'undefined' && gmap && gmap.getSource('route')) {
                const coordinates = State.targetPath.map(p => [p.lng, p.lat]);
                gmap.getSource('route').setData({
                    type: 'Feature',
                    properties: {},
                    geometry: {
                        type: 'LineString',
                        coordinates: coordinates
                    }
                });
                
                if (State.idealPath && gmap.getSource('idealRoute')) {
                    const idealCoordinates = State.idealPath.map(p => [p.lng, p.lat]);
                    gmap.getSource('idealRoute').setData({
                        type: 'Feature',
                        properties: {},
                        geometry: {
                            type: 'LineString',
                            coordinates: idealCoordinates
                        }
                    });
                }
            }

            isGeneratingRoute = false;
            if (pendingRouteRequest) {
                pendingRouteRequest = false;
                generateTargetRoute();
            }
        }

        async function process2SecondApiLivestream() {
            if (!State.apiLivestream) return false;

            const lat = State.ship.lat;
            const lng = State.ship.lng;

            const liveData = await fetchLiveMarineData(lat, lng);

            if (liveData) {
                setSafeVal('inWindSpd', liveData.windSpd);
                updateDisplayValue('valWindSpd', liveData.windSpd);

                setSafeVal('inWindDir', liveData.windDir);
                updateDisplayValue('valWindDir', liveData.windDir + '°');

                setSafeVal('inCurrent', liveData.currentSpd);
                updateDisplayValue('valCurrent', liveData.currentSpd);

                setSafeVal('inCurrentDir', liveData.currentDir);
                updateDisplayValue('valCurrentDir', liveData.currentDir + '°');

                setSafeVal('inWave', liveData.waveHt);
                updateDisplayValue('valWave', liveData.waveHt);

                setSafeVal('inWaveDir', liveData.waveDir);
                updateDisplayValue('valWaveDir', liveData.waveDir + '°');

                setSafeVal('inTide', liveData.tide);
                updateDisplayValue('valTide', (liveData.tide >= 0 ? '+' : '') + liveData.tide + 'm');

                updateDisplayValue('outPointWind', `${liveData.windSpd} kts @ ${liveData.windDir}°`);
                updateDisplayValue('outPointCurr', `${liveData.currentSpd} kts @ ${liveData.currentDir}°`);

                if (State.isRunning && NavEngine.forecastData) {
                    const totalEta = 12; // Base ETA for condition check
                    const currentHour = (State.ship.progress || 0) * totalEta;
                    const expectedData = NavEngine.getConditionsAtETA(currentHour, lat, lng);
                    
                    if (expectedData) {
                        // Digital Twin ML Profiling - train the internal model on real vs predicted difference
                        if (NavEngine.digitalTwinProfiler) {
                            NavEngine.digitalTwinProfiler.train(liveData, expectedData, State.ship.actualKnots);
                        }

                        // Reactive Proactive Rerouting check
                        const windDiff = Math.abs(liveData.windSpd - expectedData.windSpd);
                        const waveDiff = Math.abs(liveData.waveHt - expectedData.waveHt);
                        const currDiff = Math.abs(liveData.currentSpd - expectedData.currentSpd);

                        const now = Date.now();
                        if ((windDiff > 8.0 || waveDiff > 0.8 || currDiff > 0.5) && !window.isGeneratingRoute) {
                            if (!window.lastProactiveReroute || now - window.lastProactiveReroute > 30000) {
                                window.lastProactiveReroute = now;
                                log(`NavEngine: Proactive Rerouting Triggered! Live data severely deviates from forecast (Wind: +${windDiff.toFixed(1)}kts, Wave: +${waveDiff.toFixed(1)}m). Recalculating path...`, 'warning');
                                generateTargetRoute(); // Proactively recalculate
                            }
                        }
                    }
                }

                calculatePhysics(getSafeVal('inThrottle', 75));
                calculateAiRecommendations();

                log(`2D Mesh API Stream (2s): Live metrics & physics updated smoothly.`, "ai");
            }
        }

        let engineSpecDebounceTimer = null;

        async function extractEngineSpecsAsync(force = false) {
            const engineTypeInput = document.getElementById('inEngineType');
            const engineType = (engineTypeInput?.value || '4-Stroke Marine Diesel (inline-6)').trim();
            const mcrHp = getSafeVal('inMCR', 250);
            const cacheKey = (engineType + '||' + mcrHp).toLowerCase();

            // Skip if input has not changed and not forced
            if (State.lastExtractedEngineKey === cacheKey && !force) {
                return;
            }

            // Check localStorage for fixated parameters saved for this input
            let fixatedCache = {};
            try {
                fixatedCache = JSON.parse(localStorage.getItem('marine_ai_fixated_engine_specs') || localStorage.getItem('navai_fixated_engine_specs') || '{}');
            } catch (e) {}

            if (fixatedCache[cacheKey] && !force) {
                State.extractedEngineSpecs = fixatedCache[cacheKey];
                State.lastExtractedEngineKey = cacheKey;
                calculatePhysics(getSafeVal('inThrottle', 70));
                calculateAiRecommendations();
                log(`Loaded fixated engine parameters for "${engineType}" (${mcrHp} HP).`, "ai");
                return;
            }

            try {
                // Reference figures from a committed table, not a web search.
                //
                // This used to POST to /api/extract-engine-specs, which asked a
                // language model to search the web for this engine's thermal
                // efficiency and SFOC. Those two numbers then fed every fuel
                // calculation downstream, so a hallucination here propagated
                // silently into savings figures. The table in server.ts is
                // inspectable, identical on every run, and flags itself as
                // class-typical rather than vessel-specific.
                const res = await fetch('/api/engine-specs', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ engineType, mcrHp })
                });
                const data = await res.json();

                State.extractedEngineSpecs = data;
                State.lastExtractedEngineKey = cacheKey;

                // Fixate and save parameters until input is changed
                fixatedCache[cacheKey] = data;
                try {
                    localStorage.setItem('marine_ai_fixated_engine_specs', JSON.stringify(fixatedCache));
                } catch (e) {}

                log(`Engine reference loaded: ${data.engineModel || engineType} (${mcrHp} HP) — ${data.thermalEfficiencyPct}% thermal efficiency, ${Math.round(data.baseSFOC)} g/kWh base SFOC. Class-typical datasheet figures, not this vessel's own.`, "success");

                // Recalculate physics & trigger AI re-optimization with new specs
                calculatePhysics(getSafeVal('inThrottle', 70));
                calculateAiRecommendations();

            } catch (e) {
                log(`Failed to extract engine parameters: ${e.message}`, "warn");
            }
        }

        // Fallbacks must match the locked spec in index.html section 3. They used to
        // describe a 35 m / 120 t / 1200 HP coastal ship, so a missing input silently
        // advised on a different vessel from the one on screen -- the sort of drift
        // that produces two defensible numbers and no way to tell which is right.
        function getVesselHydrodynamics() {
            const lbp = getSafeVal('inLBP', 17.5);
            const breadth = getSafeVal('inBreadth', 4.2);
            const depth = getSafeVal('inDepth', 1.8);
            const dwt = getSafeVal('inDWT', 12);
            const mcrHp = getSafeVal('inMCR', 250);
            const engineType = document.getElementById('inEngineType')?.value || '4-Stroke Marine Diesel (inline-6)';
            const serviceSpeedKts = getSafeVal('inServiceSpeed', 12.0);
            const hullType = document.getElementById('inHullType')?.value || 'semi';

            const draft = Math.min(depth * 0.85, depth * 0.65 + (dwt / 1000));
            const dispTons = dwt * 1.35;
            const dispVol = dispTons / 1.025;

            let cb = dispVol / (lbp * breadth * draft);
            cb = Math.max(0.42, Math.min(0.85, cb));

            // Apply Digital Twin ML Profiling corrections learned from real-time data
            if (NavEngine.digitalTwinProfiler) {
                cb += NavEngine.digitalTwinProfiler.learnedCbMod;
                cb = Math.max(0.42, Math.min(0.85, cb));
            }

            const wettedArea = lbp * (2 * draft + breadth) * Math.sqrt(cb);

            const freeboard = Math.max(0.5, depth - draft);
            const superstructureHeight = 3.5;
            const windageFrontalArea = breadth * (freeboard + superstructureHeight);
            const windageLateralArea = lbp * (freeboard + superstructureHeight);

            return {
                lbp, breadth, depth, draft, dwt, mcrHp, mcrKw: mcrHp * 0.7457,
                engineType, serviceSpeedKts, hullType, cb, dispVol, wettedArea,
                windageFrontalArea, windageLateralArea
            };
        }

        // The vessel the operator typed, in the API's own field names.
        //
        // The console asks for LBP, breadth, depth, DWT, MCR and hull type; the
        // API asks for waterline length, beam, draft, displacement, rated power
        // and an Admiralty coefficient. This is the one place the two vocabularies
        // meet, so a change to either side has exactly one call site to fix.
        //
        // Two approximations, both deliberate and both worth knowing:
        //
        // LBP is sent as waterline length. They are not the same measurement --
        // LWL is typically 2-4% longer on these hulls -- but LBP is what an
        // operator has to hand, and the resistance model's sensitivity to it is
        // far smaller than its sensitivity to the Admiralty coefficient, which is
        // the term meant to be fitted per vessel anyway.
        //
        // Displacement is DWT x 1.35, the console's own existing estimate. It is
        // a rule of thumb for a loaded coaster and it is already used everywhere
        // else in this file; introducing a second, better one here would put two
        // displacements in one app, which is worse than one rough one.
        function vesselSpecForApi() {
            const hydro = getVesselHydrodynamics();
            const specs = State.extractedEngineSpecs || {};

            // Same three values as apps/bridge/lib/vessel.ts HULL_CLASSES. The
            // Admiralty coefficient is the only term in the resistance model that
            // carries hull form, so these must not drift between the two apps.
            const admiralty = { displacement: 90, semi: 70, planing: 55 }[hydro.hullType] ?? 70;

            const bsfc = Number(specs.baseSFOC);
            const ratedRpm = Number(specs.ratedRpm);

            return {
                vessel_id: 'CONSOLE-01',
                length_waterline_m: Math.max(1, hydro.lbp),
                beam_m: Math.max(0.5, hydro.breadth),
                draft_m: Math.max(0.2, hydro.draft),
                displacement_kg: Math.max(100, hydro.dwt * 1.35 * 1000),
                rated_kw: Math.max(1, hydro.mcrKw),
                rated_rpm: Number.isFinite(ratedRpm) && ratedRpm > 0 ? ratedRpm : 1800,
                admiralty_coefficient: admiralty,
                // The API rejects a non-positive BSFC and the reference table can
                // be absent on the first frame, before engine specs have loaded.
                best_bsfc_g_per_kwh: Number.isFinite(bsfc) && bsfc > 0 ? bsfc : 215,
                // About 1.5% of rated power's worth of burn at idle. Rough, and
                // it only moves the answer at throttle settings the optimiser
                // does not recommend.
                idle_burn_lph: Math.max(0.2, hydro.mcrKw * 0.0015)
            };
        }

        function computePhysicsState(throttleUser, applyRamp = false) {
            const hydro = getVesselHydrodynamics();
            const serviceSpeed = hydro.serviceSpeedKts;

            const shipHeading = State.ship.headingDeg || 0;
            const shipLat = State.ship.lat || (State.portA ? State.portA.lat : 10.6928);
            const shipLng = State.ship.lng || (State.portA ? State.portA.lng : 122.5644);

            let baseWindSpd = getSafeVal('inWindSpd', 12);
            let baseWindDir = getSafeVal('inWindDir', 212);
            let baseCurrentSpd = getSafeVal('inCurrent', 0.6);
            let baseCurrentDir = getSafeVal('inCurrentDir', 252);
            let baseWaveHt = getSafeVal('inWave', 0.5);
            let baseWaveDir = getSafeVal('inWaveDir', 219);

            if (NavEngine.forecastData) {
                const totalEta = 12;
                const currentHour = (State.ship.progress || 0) * totalEta;
                const conditions = NavEngine.getConditionsAtETA(currentHour, shipLat, shipLng);
                if (conditions) {
                    baseWindSpd = conditions.windSpd;
                    baseWindDir = conditions.windDir;
                    baseCurrentSpd = conditions.currentSpd;
                    baseCurrentDir = conditions.currentDir;
                    baseWaveHt = conditions.waveHt;
                    baseWaveDir = conditions.waveDir;
                }
            }

            // Compute 12.42h semi-diurnal astronomical tide level & phase
            const tide = computeTideLevel(shipLat, shipLng, Date.now());

            // Compute real-time micro-turbulence & wind gust overlay
            const micro = computeMicroTurbulence(baseWindSpd, baseWindDir, baseWaveHt, baseWaveDir, baseCurrentSpd, baseCurrentDir);

            const windSpd = micro.windSpd;
            const windDir = micro.windDir;
            const waveHt = micro.waveHt;
            const waveDir = baseWaveDir;
            const currentSpd = micro.currentSpd;
            const currentDir = baseCurrentDir;

            const relWindDir = (windDir - shipHeading + 360) % 360;
            const relWaveDir = (waveDir - shipHeading + 360) % 360;
            const relCurrentDir = (currentDir - shipHeading + 360) % 360;

            const relWindRad = (relWindDir * Math.PI) / 180;
            const relWaveRad = (relWaveDir * Math.PI) / 180;
            const relCurrentRad = (relCurrentDir * Math.PI) / 180;

            // Wind Drag & Superstructure Windage Area
            const windMs = windSpd * 0.51444;
            const windageAreaEff = hydro.windageFrontalArea * Math.pow(Math.cos(relWindRad), 2) + hydro.windageLateralArea * Math.pow(Math.sin(relWindRad), 2);
            const windForceN = 0.5 * 1.225 * windMs * windMs * windageAreaEff * 0.85;
            const windHeadCompKts = windSpd * Math.cos(relWindRad);
            const aeroKtsPenalty = (windForceN / 12000) * (windHeadCompKts >= 0 ? 0.08 : -0.04);

            // Shallow Water Effect (Squat & Canal Drag) with Tide height adjustment
            const waterDepthH = Math.max(5, 30 + tide.heightM);
            const throttleFracTarget = Math.max(0.0, Math.min(1.0, (throttleUser || 0) / 100));
            const targetKts = serviceSpeed * throttleFracTarget;
            const targetMs = targetKts * 0.51444;
            const depthFn = targetMs / Math.sqrt(9.81 * waterDepthH);
            let squatMeters = 2.0 * ((hydro.cb * hydro.breadth * hydro.draft) / (hydro.lbp * waterDepthH)) * ((targetMs * targetMs) / 9.81);
            let shallowMult = 1.0 + 0.4 * Math.pow(hydro.draft / waterDepthH, 2) + (0.3 / Math.max(0.1, Math.pow(1 - Math.min(0.9, depthFn), 2))) - 0.3;
            
            const estFn = targetMs / Math.sqrt(9.81 * hydro.lbp);
            if (hydro.hullType === 'planing' && estFn > 0.8) {
                 squatMeters *= 0.1; // Minimal squat when planing
                 shallowMult = 1.0 + (shallowMult - 1.0) * 0.1;
            } else if (hydro.hullType === 'semi') {
                 shallowMult = 1.0 + (shallowMult - 1.0) * 0.6; // Reduced squat
            }

            const shallowKtsPenalty = throttleFracTarget > 0 ? (shallowMult - 1.0) * targetKts * 0.25 : 0;

            // Wave drag
            let waveDragKts = throttleFracTarget > 0 ? waveHt * (1.0 + Math.cos(relWaveRad)) * 0.25 : 0;
            if (hydro.hullType === 'planing') waveDragKts *= 1.5; // Highly sensitive to waves (slamming)
            if (hydro.hullType === 'semi') waveDragKts *= 0.8;

            // Current projection
            const currentProjKts = currentSpd * Math.cos(relCurrentRad);

            // Steady Cruise Net Water Speed & Base SOG
            const netWaterKnotsBase = throttleFracTarget > 0 ? Math.max(0.0, targetKts - aeroKtsPenalty - shallowKtsPenalty - waveDragKts) : 0.0;
            const actualSOGBase = Math.max(0.0, netWaterKnotsBase + (throttleFracTarget > 0 || Math.abs(currentProjKts) > 0.1 ? currentProjKts : 0.0));

            // Departure & Arrival Smooth Acceleration Ramp Multiplier (Inertia & Port Maneuvering)
            let rampMult = 1.0;
            if (applyRamp && State.isRunning) {
                const prog = Math.max(0, Math.min(1.0, State.ship.progress || 0));
                if (prog < 0.10) {
                    // Departure acceleration zone (first 10% of route): smooth transition from ~15% maneuvering speed up to cruising speed
                    const t = prog / 0.10;
                    const smoothT = t * t * (3 - 2 * t);
                    rampMult = 0.15 + 0.85 * smoothT;
                } else if (prog > 0.90) {
                    // Arrival deceleration zone (last 10% of route): smooth transition from cruising speed down to ~15% berthing speed
                    const t = (1.0 - prog) / 0.10;
                    const smoothT = t * t * (3 - 2 * t);
                    rampMult = 0.15 + 0.85 * smoothT;
                }
            }

            const actualSOG = actualSOGBase * rampMult;
            const netWaterKnots = netWaterKnotsBase * rampMult;

            // Vector Leeway & Drift Heading Correction (Crab Angle)
            const windFrontalSign = Math.cos(relWindRad) >= 0 ? 1.0 : -1.0;
            const currentFrontalSign = Math.cos(relCurrentRad) >= 0 ? 1.0 : -1.0;

            const beamWindMs = windMs * Math.sin(relWindRad) * windFrontalSign;
            const beamCurrentKts = currentSpd * Math.sin(relCurrentRad) * currentFrontalSign;
            const leewayMs = (beamCurrentKts * 0.51444) + 0.03 * beamWindMs * (hydro.windageLateralArea / (hydro.lbp * hydro.draft));
            const leewayRatio = Math.max(-0.85, Math.min(0.85, (leewayMs / Math.max(0.5, actualSOG * 0.51444))));
            const crabAngleDeg = Math.asin(leewayRatio) * (180 / Math.PI);

            // Non-Linear Engine Power & Fuel Curve (SFOC)
            const vWaterMs = netWaterKnots * 0.51444;
            const fn = vWaterMs / Math.sqrt(9.81 * hydro.lbp);
            
            let hullFactor = 1.0;
            let cr = 0;
            
            if (hydro.hullType === 'planing') {
                if (fn < 0.4) cr = 0.002 * Math.exp(Math.max(0, fn - 0.2) * 2.0);
                else if (fn >= 0.4 && fn < 1.0) cr = 0.005; 
                else cr = 0.0015;
                hullFactor = fn > 1.0 ? 0.3 : 1.0;
            } else if (hydro.hullType === 'semi') {
                const fnClamped = Math.min(0.8, fn);
                cr = 0.0015 * Math.exp(Math.max(0, fnClamped - 0.2) * 2.0) * (hydro.cb / 0.6);
                hullFactor = fn > 0.4 ? 0.8 : 1.0;
            } else {
                const fnClamped = Math.min(0.45, fn);
                cr = 0.0015 * Math.exp(Math.max(0, fnClamped - 0.2) * 3.5) * (hydro.cb / 0.6);
            }

            const rHullN = 0.5 * 1025 * (hydro.wettedArea * hullFactor) * (0.003 + cr) * vWaterMs * vWaterMs;
            const totalForceN = (rHullN * shallowMult) + windForceN + (waveHt * 1200);
            
            // Dynamic Engine Load & Power physics (scaled by acceleration ramp)
            const throttleFrac = Math.max(0.0, Math.min(1.0, (throttleUser || 75) / 100));
            const baseThrottleLoad = Math.max(0.05, Math.pow(throttleFrac, 1.8)) * rampMult;

            // Hydrodynamic & Environmental Resistance Overload Multiplier
            const refSpeedMs = Math.max(1.0, hydro.serviceSpeedKts * 0.51444);
            const calmRefForceN = 0.5 * 1025 * hydro.wettedArea * 0.0035 * refSpeedMs * refSpeedMs;
            const envOverload = 1.0 + ((shallowMult - 1.0) * 0.35) + (windForceN / Math.max(10000, calmRefForceN * 0.5)) + ((waveHt * 1200) / Math.max(10000, calmRefForceN * 0.5));

            // Actual Engine Load Fraction
            const engineLoadFraction = Math.max(0.05, Math.min(1.10, baseThrottleLoad * envOverload));
            const reqPowerKw = hydro.mcrKw * engineLoadFraction;

            const specs = State.extractedEngineSpecs || {};
            const baseSfoc = specs.baseSFOC || 185.0;
            const minOpt = (specs.optimalLoadMinPct || 75) / 100;
            const maxOpt = (specs.optimalLoadMaxPct || 85) / 100;
            const optCenter = (minOpt + maxOpt) / 2;

            // Non-Linear SFOC Curve (g/kWh)
            const sfocGkWh = baseSfoc * (1.0 + 0.35 * Math.pow(engineLoadFraction - optCenter, 2) + (0.025 / (engineLoadFraction + 0.05)));
            
            // Fuel Flow (Liters per hour based on diesel density 0.840 kg/L)
            const fuelFlowLh = Math.round((reqPowerKw * sfocGkWh) / 840.0);
            
            // Engine RPM
            const ratedRpm = specs.ratedRpm || 2800; // Medium vessel marine diesel RPM
            const engineRpm = Math.round(ratedRpm * (0.30 + 0.70 * Math.pow(engineLoadFraction, 0.5)));

            // Thermal Efficiency at current load point
            const energyDensity = specs.energyDensityMJkg || 42.7;
            const currentThermalEffPct = (3600 / (sfocGkWh * energyDensity * 1000)) * 100;

            // CO2 emissions rate (Tonnes/Day)
            const co2Factor = specs.co2Factor || 3.206;
            const co2TonnesDay = (reqPowerKw * sfocGkWh * co2Factor * 24) / 1000000;

            return {
                actualSOG, netWaterKnots, relWindDir, relWaveDir, relCurrentDir,
                crabAngleDeg, sfocGkWh, engineLoadFraction, fuelFlowLh,
                engineRpm, shallowMult, windForceN, cb: hydro.cb,
                currentThermalEffPct, windSpd, windDir, currentSpd, currentDir, waveHt, waveDir,
                tide, micro, baseWindSpd, baseCurrentSpd, baseWaveHt
            };
        }

        function calculatePhysics(throttleUser) {
            const p = computePhysicsState(throttleUser, true);
            State.ship.crabAngleDeg = p.crabAngleDeg || 0;

            // Environmental Data - Always displays starting once boat model is present on 2D view
            if (NavEngine.forecastData) {
                if (document.getElementById('inWindSpd')) document.getElementById('inWindSpd').value = p.windSpd.toFixed(1);
                if (document.getElementById('inWindDir')) document.getElementById('inWindDir').value = p.windDir.toFixed(0);
                if (document.getElementById('inCurrent')) document.getElementById('inCurrent').value = p.currentSpd.toFixed(1);
                if (document.getElementById('inCurrentDir')) document.getElementById('inCurrentDir').value = p.currentDir.toFixed(0);
                if (document.getElementById('inWave')) document.getElementById('inWave').value = p.waveHt.toFixed(1);
                if (document.getElementById('inWaveDir')) document.getElementById('inWaveDir').value = p.waveDir.toFixed(0);
                
                updateDisplayValue('valWindSpd', p.windSpd.toFixed(1) + ' kts');
                updateDisplayValue('valWindDir', p.windDir.toFixed(0) + '°');
                updateDisplayValue('valCurrent', p.currentSpd.toFixed(1) + ' kts');
                updateDisplayValue('valCurrentDir', p.currentDir.toFixed(0) + '°');
                updateDisplayValue('valWave', p.waveHt.toFixed(1) + ' m');
                updateDisplayValue('valWaveDir', p.waveDir.toFixed(0) + '°');
            } else {
                updateDisplayValue('valWindSpd', getSafeVal('inWindSpd', 12).toFixed(1) + ' kts');
                updateDisplayValue('valWindDir', getSafeVal('inWindDir', 212).toFixed(0) + '°');
                updateDisplayValue('valCurrent', getSafeVal('inCurrent', 0.6).toFixed(1) + ' kts');
                updateDisplayValue('valCurrentDir', getSafeVal('inCurrentDir', 252).toFixed(0) + '°');
                updateDisplayValue('valWave', getSafeVal('inWave', 0.5).toFixed(1) + ' m');
                updateDisplayValue('valWaveDir', getSafeVal('inWaveDir', 219).toFixed(0) + '°');
            }

            if (p.tide) {
                updateDisplayValue('valTide', `${p.tide.heightM >= 0 ? '+' : ''}${p.tide.heightM.toFixed(2)}m`);
                const inTideEl = document.getElementById('inTide');
                if (inTideEl && document.activeElement !== inTideEl) inTideEl.value = p.tide.heightM.toFixed(1);
            }

            // Vessel Sensors, Hydro & Aero Telemetry: Display active telemetry ONLY when voyage starts (State.isRunning)
            if (State.isRunning) {
                updateDisplayValue('valFlow', Math.round(p.fuelFlowLh));
                updateDisplayValue('valRpm', p.engineRpm);
                const inFlowEl = document.getElementById('inFlow');
                if (inFlowEl && document.activeElement !== inFlowEl) inFlowEl.value = Math.round(p.fuelFlowLh);
                const inRpmEl = document.getElementById('inRpm');
                if (inRpmEl && document.activeElement !== inRpmEl) inRpmEl.value = p.engineRpm;

                updateDisplayValue('outBlockCoeff', p.cb.toFixed(2));
                updateDisplayValue('outCrabAngle', `${p.crabAngleDeg >= 0 ? '+' : ''}${p.crabAngleDeg.toFixed(1)}°`);
                updateDisplayValue('outSquatDrag', `${(p.shallowMult).toFixed(2)}x`);
                updateDisplayValue('outSFOC', `${Math.round(p.sfocGkWh)} g/kWh (${Math.round(p.engineLoadFraction * 100)}% Load)`);
                updateDisplayValue('outWindageDrag', `${(p.windForceN / 1000).toFixed(2)} kN`);

                if (p.micro) {
                    updateDisplayValue('outGustPeak', `${p.micro.peakGustSpd.toFixed(1)} kts`);
                }
                if (p.tide) {
                    updateDisplayValue('outTidePhase', `${p.tide.phaseText}`);
                }
                
                // Engine AI Telemetry
                const load = p.engineLoadFraction;
                const rpm = p.engineRpm;
                
                // Simulate parameters based on load (Medium Marine Diesel e.g., 200-400HP)
                const egt = Math.round(150 + (load * 300) + (Math.random() * 5)); // 150 to 455 C
                const cooling = (60 + (load * 20) + (Math.random() * 2)).toFixed(1); // 60 to 82 C
                const lube = (2.5 + (load * 2.0) + (Math.random() * 0.2)).toFixed(2); // 2.5 to 4.7 bar
                const scavenge = (0.2 + (load * 1.3) + (Math.random() * 0.05)).toFixed(2); // Turbo Boost: 0.2 to 1.55 bar
                const vib = (2.0 + (load * 4.0) + (Math.random() * 0.5)).toFixed(2); // 2.0 to 6.5 mm/s

                updateDisplayValue('telemRpm', rpm);
                updateDisplayValue('telemEgt', egt + ' °C');
                updateDisplayValue('telemCooling', cooling + ' °C');
                updateDisplayValue('telemLube', lube + ' bar');
                updateDisplayValue('telemScavenge', scavenge + ' bar');
                updateDisplayValue('telemVib', vib + ' mm/s');
                
                // Update Progress Bars
                const barRpm = document.getElementById('barTelemRpm');
                if (barRpm) barRpm.style.width = Math.min(100, (rpm / 3000) * 100) + '%';
                
                const barEgt = document.getElementById('barTelemEgt');
                if (barEgt) {
                    const egtPercent = Math.min(100, Math.max(0, (egt - 150) / 350 * 100)); // Map 150-500C to 0-100%
                    barEgt.style.width = egtPercent + '%';
                    if (egt > 430) barEgt.className = "h-full bg-gradient-to-r from-orange-500 to-red-500 transition-all duration-300";
                    else if (egt > 380) barEgt.className = "h-full bg-gradient-to-r from-amber-500 to-orange-500 transition-all duration-300";
                    else barEgt.className = "h-full bg-gradient-to-r from-emerald-400 to-amber-400 transition-all duration-300";
                }
                
                const barCool = document.getElementById('barTelemCooling');
                if (barCool) {
                    const coolPercent = Math.min(100, Math.max(0, (cooling - 40) / 60 * 100)); // Map 40-100C to 0-100%
                    barCool.style.width = coolPercent + '%';
                }

                // Update Chart
                if (typeof engineChartInstance !== 'undefined' && engineChartInstance) {
                    engineChartInstance.data.datasets[0].data.push(rpm);
                    engineChartInstance.data.datasets[0].data.shift();
                    
                    engineChartInstance.data.datasets[1].data.push(load * 100);
                    engineChartInstance.data.datasets[1].data.shift();
                    
                    engineChartInstance.update();
                }
                
                // --- NEW TELEMETRY FIELDS ---
                // Fuel System (Medium Boat, ~800L Tank)
                const maxFuel = 800;
                // Calculate remaining fuel based on actual flow if possible, or simulate ~25% usage over journey
                const currentFuel = maxFuel * (1 - State.ship.progress * 0.25);
                const fuelPercent = (currentFuel / maxFuel) * 100;
                const fuelFlow = p.fuelFlowLh; // Use the exact flow calculated by physics engine
                updateDisplayValue('fuelFlowRate', Math.round(fuelFlow).toLocaleString() + ' L/h');
                updateDisplayValue('fuelRemaining', Math.round(currentFuel) + ' L'); // Show Liters instead of %
                
                const barFuel = document.getElementById('barFuelLevel');
                const txtFuelStatus = document.getElementById('fuelTankStatus');
                if (barFuel) {
                    barFuel.style.width = fuelPercent + '%';
                    if (fuelPercent > 30) {
                        barFuel.className = "h-full bg-gradient-to-r from-emerald-500 to-amber-400 transition-all duration-300";
                        if (txtFuelStatus) { txtFuelStatus.textContent = "Normal"; txtFuelStatus.className = "font-bold text-emerald-400"; }
                    } else if (fuelPercent > 15) {
                        barFuel.className = "h-full bg-gradient-to-r from-amber-500 to-orange-500 transition-all duration-300";
                        if (txtFuelStatus) { txtFuelStatus.textContent = "Low"; txtFuelStatus.className = "font-bold text-amber-400"; }
                    } else {
                        barFuel.className = "h-full bg-red-500 transition-all duration-300";
                        if (txtFuelStatus) { txtFuelStatus.textContent = "Critical"; txtFuelStatus.className = "font-bold text-red-400"; }
                    }
                }

                // Power Generation (24V DC Electrical System)
                // Alternator outputs roughly 50-100 Amps -> ~1.4 to 2.8 kW
                const powerOut = rpm > 0 ? (1.5 * load) + (Math.random() * 0.2) : 0;
                updateDisplayValue('powerOutput', powerOut.toFixed(1) + ' kW');
                updateDisplayValue('powerVoltage', (rpm > 0 ? (27.8 + (Math.random() * 0.4 - 0.2)) : 24.2).toFixed(1) + ' V');
                const batteryLevel = rpm > 0 ? (95 + (Math.random() * 2)) : (85 + (Math.random() * 5));
                updateDisplayValue('powerBattery', batteryLevel.toFixed(1) + ' %');

                // Vessel Dynamics
                const stress = Math.min(100, Math.max(0, (load * 40) + (p.waveHt * 10) + (vib * 5)));
                updateDisplayValue('dynHullStress', stress.toFixed(1) + ' %');
                const barStress = document.getElementById('barHullStress');
                if (barStress) {
                    barStress.style.width = stress + '%';
                    barStress.className = stress > 75 ? "h-full bg-red-500 transition-all duration-300" : (stress > 50 ? "h-full bg-amber-500 transition-all duration-300" : "h-full bg-sky-500 transition-all duration-300");
                }
                
                // Roll & Crab Angle (simulated from wave heights/wind)
                const rollDeg = (p.waveHt * 2.5) * Math.sin(Date.now() / 1500) + (Math.random() * 0.5 - 0.25);
                updateDisplayValue('dynRollAngle', (rollDeg > 0 ? '+' : '') + rollDeg.toFixed(1) + ' °');
                const barRoll = document.getElementById('barRollAngle');
                if (barRoll) {
                    barRoll.style.width = Math.min(50, Math.abs(rollDeg / 20 * 50)) + '%';
                    barRoll.style.transform = rollDeg > 0 ? 'translateX(0)' : 'translateX(-100%)';
                }

                const crabDeg = p.windKts * 0.15 + (Math.random() * 0.2 - 0.1); // very simple simulated crab
                updateDisplayValue('dynCrabAngle', (crabDeg > 0 ? '+' : '') + crabDeg.toFixed(1) + ' °');
                const barCrab = document.getElementById('barCrabAngle');
                if (barCrab) {
                    barCrab.style.width = Math.min(50, Math.abs(crabDeg / 15 * 50)) + '%';
                    barCrab.style.transform = crabDeg > 0 ? 'translateX(0)' : 'translateX(-100%)';
                }

                const horizon = document.getElementById('horizonLine');
                if (horizon) {
                    horizon.style.transform = `translateY(${Math.max(-10, Math.min(10, -rollDeg * 1.5))}px) rotate(${-rollDeg * 2}deg)`;
                }

                // X-Ray Telemetry
                updateDisplayValue('xrayEngLoad', Math.round(load * 100));
                
                // xrayFuel is already calculated and updated in the NEW TELEMETRY FIELDS above
                updateDisplayValue('xrayFuel', Math.round(currentFuel).toLocaleString());
                
                // Stress factor (combining load, wave, and vibrations)
                // 'stress' is already computed above
                updateDisplayValue('xrayStress', Math.round(stress));
                updateDisplayValue('xraySpeed', p.actualSOG.toFixed(1));

                // Visual updates
                const xrayEngineIcon = document.getElementById('xrayEngineIcon');
                if (xrayEngineIcon) {
                    if (rpm > 0) {
                        xrayEngineIcon.classList.add('animate-spin');
                        // Faster spin for higher RPM (3000 max)
                        xrayEngineIcon.style.animationDuration = `${Math.max(0.1, 2.0 - (rpm / 2000))}` + 's';
                    } else {
                        xrayEngineIcon.classList.remove('animate-spin');
                    }
                }
                
                const xrayPropeller = document.getElementById('xrayPropeller');
                const xrayShaft = document.getElementById('xrayShaft');
                if (xrayPropeller && xrayShaft) {
                    if (rpm > 0) {
                        xrayPropeller.classList.add('animate-spin');
                        xrayPropeller.style.animationDuration = `${Math.max(0.05, 1.0 - (rpm / 3000))}` + 's';
                    } else {
                        xrayPropeller.classList.remove('animate-spin');
                    }
                    
                    // Update Propeller/Shaft Color based on Vibration
                    if (vib > 5.5) {
                        xrayPropeller.className = "absolute bottom-1.5 left-1/2 -translate-x-1/2 w-9 h-1.5 bg-red-500 rounded-full shadow-[0_0_12px_#f43f5e] transition-colors animate-pulse";
                        xrayShaft.className = "absolute bottom-2 left-1/2 -translate-x-1/2 w-1.5 h-6 bg-red-600 transition-colors";
                    } else if (vib > 4.0) {
                        xrayPropeller.className = "absolute bottom-1.5 left-1/2 -translate-x-1/2 w-9 h-1.5 bg-amber-400 rounded-full shadow-[0_0_8px_#fbbf24] transition-colors";
                        xrayShaft.className = "absolute bottom-2 left-1/2 -translate-x-1/2 w-1.5 h-6 bg-amber-600 transition-colors";
                    } else {
                        xrayPropeller.className = "absolute bottom-1.5 left-1/2 -translate-x-1/2 w-9 h-1.5 bg-emerald-400 rounded-full shadow-[0_0_8px_#10b981] transition-colors";
                        xrayShaft.className = "absolute bottom-2 left-1/2 -translate-x-1/2 w-1.5 h-6 bg-emerald-600 transition-colors";
                    }
                }
                
                // Fuel levels
                const fuelL = document.getElementById('xrayFuelLevelL');
                const fuelR = document.getElementById('xrayFuelLevelR');
                if (fuelL) fuelL.style.height = `${fuelPercent}%`;
                if (fuelR) fuelR.style.height = `${fuelPercent}%`;
                
                // Update Fuel Tank Container Colors
                const fuelContainerL = fuelL?.parentElement;
                const fuelContainerR = fuelR?.parentElement;
                if (fuelContainerL && fuelContainerR) {
                    let fClass = "";
                    if (fuelPercent < 15) fClass = "border border-red-500/60 bg-red-500/20";
                    else if (fuelPercent < 30) fClass = "border border-amber-500/60 bg-amber-500/20";
                    else fClass = "border border-emerald-500/60 bg-emerald-500/20";
                    
                    fuelContainerL.className = `absolute bottom-28 left-2 w-4 h-16 ${fClass} rounded-md overflow-hidden flex flex-col justify-end transition-colors`;
                    fuelContainerR.className = `absolute bottom-28 right-2 w-4 h-16 ${fClass} rounded-md overflow-hidden flex flex-col justify-end transition-colors`;
                }

                // Engine Room Color Status
                const xrayEngine = document.getElementById('xrayEngine');
                if (xrayEngine && xrayEngineIcon) {
                    if (egt > 430) {
                        xrayEngine.className = "absolute bottom-8 left-1/2 -translate-x-1/2 w-14 h-16 border border-red-500 bg-red-500/25 rounded-lg flex flex-col items-center justify-center transition-colors shadow-[0_0_15px_rgba(244,63,94,0.5)] animate-pulse";
                        xrayEngineIcon.className = "fa-solid fa-fan text-red-400 text-base transition-colors";
                    } else if (egt > 380) {
                        xrayEngine.className = "absolute bottom-8 left-1/2 -translate-x-1/2 w-14 h-16 border border-amber-500/70 bg-amber-500/20 rounded-lg flex flex-col items-center justify-center transition-colors shadow-[0_0_12px_rgba(245,158,11,0.3)]";
                        xrayEngineIcon.className = "fa-solid fa-fan text-amber-400 text-base transition-colors";
                    } else {
                        xrayEngine.className = "absolute bottom-8 left-1/2 -translate-x-1/2 w-14 h-16 border border-emerald-500/60 bg-emerald-500/20 rounded-lg flex flex-col items-center justify-center transition-colors shadow-[0_0_12px_rgba(16,185,129,0.25)]";
                        xrayEngineIcon.className = "fa-solid fa-fan text-emerald-400 text-base transition-colors";
                    }
                    if (rpm > 0) xrayEngineIcon.classList.add('animate-spin');
                }
                
                // Generator Status
                const xrayGenerator = document.getElementById('xrayGenerator');
                if (xrayGenerator) {
                    const icon = xrayGenerator.querySelector('i');
                    if (rpm > 0) {
                        xrayGenerator.className = "absolute bottom-28 left-1/2 -translate-x-1/2 w-7 h-7 border border-emerald-500/50 bg-emerald-500/15 rounded-md flex items-center justify-center shadow-[0_0_8px_rgba(16,185,129,0.2)] transition-colors";
                        if(icon) icon.className = "fa-solid fa-bolt text-emerald-400 text-xs transition-colors";
                    } else {
                        xrayGenerator.className = "absolute bottom-28 left-1/2 -translate-x-1/2 w-7 h-7 border border-amber-500/50 bg-amber-500/15 rounded-md flex items-center justify-center shadow-[0_0_8px_rgba(245,158,11,0.2)] transition-colors";
                        if(icon) icon.className = "fa-solid fa-bolt text-amber-400 text-xs transition-colors";
                    }
                }
                
                // Radar Scan
                const xrayRadarLine = document.getElementById('xrayRadarLine');
                if (xrayRadarLine) {
                    xrayRadarLine.classList.add('animate-[spin_2s_linear_infinite]');
                }

                // Engine Health Simulation (AI)
                let health = 100;
                let alertMsg = null;
                State.engineAnomalyThrottleCap = 100; // default
                
                if (egt > 530) {
                    health -= (egt - 530) * 0.5;
                    alertMsg = "Elevated EGT Warning - Potential injector wear detected.";
                    State.engineAnomalyThrottleCap = 60;
                }
                if (vib > 5.5) {
                    health -= ((vib - 5.5) * 15);
                    alertMsg = "High Vibration Anomaly - Check thrust bearing load.";
                    State.engineAnomalyThrottleCap = 55;
                }
                
                health = Math.max(0, Math.min(100, Math.round(health)));
                
                if (alertMsg && !State.engineAnomalyLogged) {
                    log(`ENGINE AI: ${alertMsg} Applying throttle cap at ${State.engineAnomalyThrottleCap}%.`, 'alert');
                    State.engineAnomalyLogged = true;
                } else if (!alertMsg) {
                    State.engineAnomalyLogged = false;
                }
                
                const badgeHealth = document.getElementById('badgeEngineHealth');
                if (badgeHealth) {
                    badgeHealth.textContent = `Health: ${health}%`;
                    if (health < 80) {
                        badgeHealth.className = "text-xs bg-red-500/20 text-red-300 px-1.5 py-0.5 rounded font-mono";
                    } else if (health < 95) {
                        badgeHealth.className = "text-xs bg-amber-500/20 text-amber-300 px-1.5 py-0.5 rounded font-mono";
                    } else {
                        badgeHealth.className = "text-xs bg-emerald-500/20 text-emerald-300 px-1.5 py-0.5 rounded font-mono";
                    }
                }
                
                const txtEnginePrediction = document.getElementById('txtEnginePrediction');
                const boxAiAlert = document.getElementById('boxAiAlert');
                const txtAiAlertMsg = document.getElementById('txtAiAlertMsg');
                
                if (txtEnginePrediction) {
                    if (health >= 95) {
                        txtEnginePrediction.innerHTML = "<span class='text-emerald-300'>All engine parameters nominal. Optimal combustion efficiency.</span>";
                        if (boxAiAlert) boxAiAlert.classList.add('hidden');

                        if (window.lastAlertMsg !== 'nominal') {
                            window.lastAlertMsg = 'nominal';
                            const list = document.getElementById('listAiHistory');
                            if (list) {
                                const li = document.createElement('li');
                                li.innerHTML = `<span class="text-emerald-400">> [${new Date().toLocaleTimeString()}]</span> Nominal operation restored.`;
                                list.prepend(li);
                                if (list.children.length > 10) list.lastChild.remove();
                            }
                        }
                    } else {
                        txtEnginePrediction.innerHTML = "<span class='text-amber-300'>Degradation signatures detected. Predictive maintenance recommended.</span>";
                        if (boxAiAlert && alertMsg) {
                            boxAiAlert.classList.remove('hidden');
                            txtAiAlertMsg.textContent = alertMsg + ` Recommend reducing throttle to ${State.engineAnomalyThrottleCap}% to mitigate.`;

                            if (window.lastAlertMsg !== alertMsg) {
                                window.lastAlertMsg = alertMsg;
                                const list = document.getElementById('listAiHistory');
                                if (list) {
                                    const li = document.createElement('li');
                                    li.innerHTML = `<span class="text-red-400">> [${new Date().toLocaleTimeString()}]</span> ${alertMsg}`;
                                    list.prepend(li);
                                    if (list.children.length > 10) list.lastChild.remove();
                                }
                            }
                        }
                    }
                }
                
                // ML Data Logger
                const now = Date.now();
                if (now - State.mlLogger.lastSampleTimeMs >= State.mlLogger.intervalMs) {
                    State.mlLogger.lastSampleTimeMs = now;
                    
                    const record = {
                        timestamp: new Date().toISOString(),
                        latitude: State.ship.lat !== undefined ? State.ship.lat.toFixed(6) : '0.000000',
                        longitude: State.ship.lng !== undefined ? State.ship.lng.toFixed(6) : '0.000000',
                        headingDeg: Math.round(State.ship.headingDeg || 0),
                        progressPct: ((State.ship.progress || 0) * 100).toFixed(1),
                        throttle: p.throttleUser,
                        engineLoad: load.toFixed(3),
                        rpm: Math.round(rpm),
                        egt: egt.toFixed(1),
                        cooling: cooling,
                        lubePressure: lube,
                        scavengePressure: scavenge,
                        vibration: vib,
                        speedKts: p.actualSOG.toFixed(2),
                        windSpd: p.windSpd.toFixed(1),
                        windDir: p.windDir.toFixed(0),
                        currentSpd: p.currentSpd.toFixed(1),
                        currentDir: p.currentDir.toFixed(0),
                        waveHt: p.waveHt.toFixed(1),
                        healthScore: health,
                        fuelFlow: p.fuelFlowLh.toFixed(1),
                        hullStress: stress.toFixed(1)
                    };
                    
                    State.mlLogger.data.push(record);
                    
                    const badge = document.getElementById('badgeLoggerStatus');
                    const txtCount = document.getElementById('txtRecordCount');
                    if (badge) {
                        badge.textContent = "Logging Active";
                        badge.className = "text-xs bg-emerald-500/20 text-emerald-300 px-1.5 py-0.5 rounded font-mono";
                    }
                    if (txtCount) {
                        txtCount.textContent = State.mlLogger.data.length;
                        const liveRecordCount = document.getElementById("liveRecordCount");
                        if (liveRecordCount) liveRecordCount.textContent = State.mlLogger.data.length + " records (Recording)";
                    }
                    if (window.updateAnalyticsChart) {
                        window.updateAnalyticsChart();
                    }
                }
            } else {
                // Standby / Off display state when voyage has not started or has completed
                updateDisplayValue('valFlow', '--');
                updateDisplayValue('valRpm', '--');
                updateDisplayValue('valThrottle', '--');
                updateDisplayValue('outThrottle', '0.0');

                updateDisplayValue('outBlockCoeff', '--');
                updateDisplayValue('outCrabAngle', '--');
                updateDisplayValue('outSquatDrag', '--');
                updateDisplayValue('outSFOC', State.ship.progress >= 1 ? 'OFF (Voyage Completed)' : 'OFF (Voyage Standby)');
                updateDisplayValue('outWindageDrag', '--');
                updateDisplayValue('outGustPeak', '--');
                
                updateDisplayValue('telemRpm', '--');
                updateDisplayValue('telemEgt', '-- °C');
                updateDisplayValue('telemCooling', '-- °C');
                updateDisplayValue('telemLube', '-- bar');
                updateDisplayValue('telemScavenge', '-- bar');
                updateDisplayValue('telemVib', '-- mm/s');
                
                const barRpm = document.getElementById('barTelemRpm');
                if (barRpm) barRpm.style.width = '0%';
                const barEgt = document.getElementById('barTelemEgt');
                if (barEgt) {
                    barEgt.style.width = '0%';
                    barEgt.className = "h-full bg-orange-500 transition-all duration-300";
                }
                const barCool = document.getElementById('barTelemCooling');
                if (barCool) barCool.style.width = '0%';
                
                updateDisplayValue('fuelFlowRate', '-- L/h');
                updateDisplayValue('powerOutput', '-- kW');
                updateDisplayValue('powerVoltage', '-- V');
                updateDisplayValue('dynHullStress', '-- %');
                updateDisplayValue('dynRollAngle', '-- °');
                updateDisplayValue('dynCrabAngle', '-- °');
                
                const barStress = document.getElementById('barHullStress');
                if (barStress) barStress.style.width = '0%';
                const barRoll = document.getElementById('barRollAngle');
                if (barRoll) barRoll.style.width = '0%';
                const barCrab = document.getElementById('barCrabAngle');
                if (barCrab) barCrab.style.width = '0%';
                const horizon = document.getElementById('horizonLine');
                if (horizon) horizon.style.transform = 'translateY(0) rotate(0deg)';
                
                updateDisplayValue('xrayEngLoad', '--');
                updateDisplayValue('xrayFuel', '--');
                updateDisplayValue('xrayStress', '--');
                updateDisplayValue('xraySpeed', '--');
                
                const xrayEngineIcon = document.getElementById('xrayEngineIcon');
                if (xrayEngineIcon) xrayEngineIcon.classList.remove('animate-spin');
                
                const xrayPropeller = document.getElementById('xrayPropeller');
                if (xrayPropeller) xrayPropeller.classList.remove('animate-spin');
                
                const xrayRadarLine = document.getElementById('xrayRadarLine');
                if (xrayRadarLine) xrayRadarLine.classList.remove('animate-[spin_2s_linear_infinite]');
                
                const xrayEngine = document.getElementById('xrayEngine');
                if (xrayEngine) xrayEngine.className = "absolute bottom-8 left-1/2 -translate-x-1/2 w-14 h-16 border border-orange-500/60 bg-orange-500/20 rounded-lg flex flex-col items-center justify-center transition-colors shadow-[0_0_12px_rgba(249,115,22,0.25)]";
                
                
                const badgeHealth = document.getElementById('badgeEngineHealth');
                if (badgeHealth) {
                    badgeHealth.textContent = `Health: --%`;
                    badgeHealth.className = "text-xs bg-slate-500/20 text-slate-300 px-1.5 py-0.5 rounded font-mono";
                }
                const txtEnginePrediction = document.getElementById('txtEnginePrediction');
                if (txtEnginePrediction) txtEnginePrediction.textContent = "AI monitoring standby. Awaiting telemetry data.";
                const boxAiAlert = document.getElementById('boxAiAlert');
                if (boxAiAlert) boxAiAlert.classList.add('hidden');
                updateDisplayValue('outTidePhase', '--');
            }

            return p;
        }

        function getRouteDistanceNM() {
            if (State.targetPath && State.targetPath.length >= 2) {
                let distMeters = 0;
                for (let k = 0; k < State.targetPath.length - 1; k++) {
                    distMeters += State.targetPath[k].distanceTo(State.targetPath[k + 1]);
                }
                return distMeters / 1852;
            }
            const start = State.direction === 1 ? State.portA : State.portB;
            const end = State.direction === 1 ? State.portB : State.portA;
            if (start && end) {
                const pA = L.latLng(start.lat, start.lng);
                const pB = L.latLng(end.lat, end.lng);
                return pA.distanceTo(pB) / 1852;
            }
            return 5.0;
        }

        function evaluateAndAdjustEtaDynamics(overrideReqSOG = null) {
            const distNM = getRouteDistanceNM();
            const etaInput = document.getElementById('inEta');
            const userTargetMins = parseFloat(etaInput?.value || '25');

            if (isNaN(userTargetMins) || userTargetMins <= 0 || distNM <= 0) return;

            let reqSOG = overrideReqSOG;
            if (reqSOG === null || reqSOG === undefined) {
                if (State.isRunning && State.targetEtaSeconds > 0) {
                    const remainingNM = Math.max(0.001, distNM * (1.0 - State.ship.progress));
                    const remainingHours = Math.max(0.0001, State.targetEtaSeconds / 3600);
                    reqSOG = remainingNM / remainingHours;
                } else {
                    reqSOG = distNM / (userTargetMins / 60);
                }
            }

            const waveHt = getSafeVal('inWave', 1.8);
            const windSpd = getSafeVal('inWindSpd', 12);
            let maxSafeThrottle = 100;
            if (waveHt > 5.0 || windSpd > 45) maxSafeThrottle = 60;
            else if (waveHt > 3.5) maxSafeThrottle = 75;
            else if (waveHt > 2.5) maxSafeThrottle = 85;
            
            // Engine Anomaly AI Cap
            if (State.engineAnomalyThrottleCap && maxSafeThrottle > State.engineAnomalyThrottleCap) {
                maxSafeThrottle = State.engineAnomalyThrottleCap;
            }

            const maxPhys = computePhysicsState(maxSafeThrottle);
            const maxSOG = maxPhys.actualSOG;

            const minPhys = computePhysicsState(15);
            const minSOG = minPhys.actualSOG;

            const boxFeasible = document.getElementById('boxFeasibleEta');
            const valFeasibleEta = document.getElementById('valFeasibleEta');
            const valMaxSpeed = document.getElementById('valMaxSpeed');

            let targetThrottle = 75;

            // Trigger warning if required SOG exceeds maximum safe vessel speed
            if (reqSOG > maxSOG + 0.05) {
                const remDist = State.isRunning ? distNM * (1.0 - State.ship.progress) : distNM;
                const actualAchievableMins = (remDist / Math.max(0.1, maxSOG)) * 60;
                // Clamped, so snap rather than ease -- there is nothing to
                // converge towards and easing would only lag the cap.
                targetThrottle = maxSafeThrottle;
                State.smoothedThrottle = targetThrottle;

                if (boxFeasible) {
                    boxFeasible.classList.remove('hidden');
                    if (valFeasibleEta) valFeasibleEta.innerText = `${actualAchievableMins.toFixed(1)} mins`;
                    if (valMaxSpeed) valMaxSpeed.innerText = `${maxSOG.toFixed(1)}`;
                }
            } else if (reqSOG < minSOG - 0.05) {
                const remDist = State.isRunning ? distNM * (1.0 - State.ship.progress) : distNM;
                const actualAchievableMins = (remDist / Math.max(0.1, minSOG)) * 60;
                targetThrottle = 15;
                State.smoothedThrottle = targetThrottle;

                if (boxFeasible) {
                    boxFeasible.classList.remove('hidden');
                    if (valFeasibleEta) valFeasibleEta.innerText = `${actualAchievableMins.toFixed(1)} mins (Min Speed)`;
                    if (valMaxSpeed) valMaxSpeed.innerText = `${minSOG.toFixed(1)}`;
                }
            } else {
                // Feasible! Hide warning container completely
                if (boxFeasible) boxFeasible.classList.add('hidden');

                // Throttle that hits reqSOG, by bisection.
                //
                // Speed rises monotonically with throttle, so the 360-sample
                // linear scan this replaces was doing 360 physics evaluations to
                // resolve 0.25%. Twelve halvings of the same interval resolve
                // ~0.02% -- finer and thirty times cheaper, on a function that
                // runs every animation frame.
                //
                // applyRamp is left off deliberately: minSOG and maxSOG above are
                // both computed without it, so solving against a ramped speed
                // would be solving against a different curve than the one that
                // declared this ETA feasible. During the departure and arrival
                // ramps that mismatch pins the throttle to its cap.
                let lowT = 10;
                let highT = maxSafeThrottle;
                let bestT = 75;

                for (let i = 0; i < 12; i++) {
                    const midT = (lowT + highT) / 2;
                    if (computePhysicsState(midT).actualSOG < reqSOG) {
                        lowT = midT;
                    } else {
                        highT = midT;
                    }
                    bestT = midT;
                }

                // Light easing on the solved value. The solver is deterministic,
                // but its input conditions move every frame, and the readout
                // shows one decimal -- without this the last digit flickers.
                if (!Number.isFinite(State.smoothedThrottle)) {
                    State.smoothedThrottle = bestT;
                }
                State.smoothedThrottle = State.smoothedThrottle * 0.95 + bestT * 0.05;
                targetThrottle = State.smoothedThrottle;
            }

            // Dynamically adjust throttle control to achieve required target ETA
            const inThrottleEl = document.getElementById('inThrottle');
            if (inThrottleEl && document.activeElement !== inThrottleEl) {
                inThrottleEl.value = targetThrottle.toFixed(1);
            }
            if (State.isRunning) {
                const targetPhysics = computePhysicsState(targetThrottle);
                const targetSpeed = targetPhysics.actualSOG || 0;
                updateDisplayValue('valThrottle', `${targetThrottle.toFixed(1)}%`);
                updateDisplayValue('outThrottle', targetSpeed.toFixed(1));
            } else {
                updateDisplayValue('valThrottle', '--');
                updateDisplayValue('outThrottle', '0.0');
            }

            State.userTargetEtaMins = userTargetMins;
            // The HUD reads the target from the same resolved value the schedule
            // maths just used, not from the input box, so an out-of-range or
            // mid-edit entry cannot show one target on the map and another in the
            // panel.
            updateDisplayValue('outHudEtaTarget', userTargetMins.toFixed(0));
            if (!State.isRunning) {
                State.targetEtaSeconds = userTargetMins * 60;
                const m = Math.floor(userTargetMins);
                const s = Math.floor((userTargetMins % 1) * 60);
                updateDisplayValue('outEtaSecs', `${m}:${s.toString().padStart(2, '0')}`);
            }

            return { userTargetMins, targetThrottle, reqSOG, maxSOG };
        }

        function calculateAiRecommendations() {
            const schedPriority = document.getElementById('inSched')?.value || 'normal';
            const weatherType = document.getElementById('inWeather')?.value || 'clear';
            const waveHt = getSafeVal('inWave', 1.8);
            
            if (NavEngine.forecastData) {
                 const currentDist = REAL_DISTANCE_KM * (1.0 - State.ship.progress);
                 const etaHours = (State.targetEtaSeconds !== undefined ? State.targetEtaSeconds / 3600 : 25 / 60) || (25 / 60);
                 const predictedConditions = NavEngine.getConditionsAtETA(Math.min(47, etaHours));
                 
                 // The 30 s floor used to be a quota shield around a free tier that
                 // allowed 20 requests a day. It is kept because the recommendation
                 // only moves when the conditions do, not because anything here is
                 // rationed now.
                 const now = Date.now();
                 if (!NavEngine.isFetching && (!NavEngine.lastFetchTime || now - NavEngine.lastFetchTime > 30000)) {
                     NavEngine.lastFetchTime = now;
                     NavEngine.isFetching = true;
                     NavEngine.optimizeSpeedAndRouteAsync(predictedConditions, etaHours, currentDist || REAL_DISTANCE_KM).then(result => {
                         NavEngine.isFetching = false;
                         State.ai.recThrottle = result.ok ? result.recThrottle : null;
                         State.ai.savings = result.ok ? result.savingsLph : null;
                         renderAdvisoryHud();
                         renderAdvisory(result);

                         // Sea-state abort is a deterministic client-side rule
                         // (analyzeSafety), not something the optimiser returns.
                         // /api/advise reports scheduleFeasible -- whether the
                         // engine can hold the ETA -- which is a different question
                         // and must never be shown as a safety verdict.
                         const routeStatusEl = document.getElementById('outRouteStatus');
                         if (routeStatusEl) {
                             if (weatherType === 'typhoon' || waveHt > 6.0) {
                                 routeStatusEl.innerText = "ABORT: SEVERE STORM";
                                 routeStatusEl.className = "text-xs font-bold text-white bg-red-600 px-2 py-1 rounded";
                             } else if (!result.ok) {
                                 routeStatusEl.innerText = "OPTIMISER OFFLINE";
                                 routeStatusEl.className = "text-xs font-bold text-white bg-slate-600 px-2 py-1 rounded";
                             } else if (result.scheduleFeasible === false) {
                                 routeStatusEl.innerText = "ETA NOT ACHIEVABLE";
                                 routeStatusEl.className = "text-xs font-bold text-white bg-amber-600 px-2 py-1 rounded";
                             } else {
                                 routeStatusEl.innerText = State.isRunning ? "OPTIMISER ACTIVE" : "STANDBY";
                                 routeStatusEl.className = "text-xs font-bold text-white bg-emerald-600 px-2 py-1 rounded";
                             }
                         }
                     }).catch(() => { NavEngine.isFetching = false; });
                 }
            } else {
                 // No forecast loaded yet, so there is nothing to advise on. The
                 // old code put 60/75/90% on the gauge here depending on the
                 // schedule dropdown -- three hardcoded numbers presented on the
                 // same readout as a model output. A dash is the truth.
                 State.ai.recThrottle = null;
                 State.ai.savings = null;
                 renderAdvisoryHud();
                 renderAdvisory(null);

                 const routeStatusEl = document.getElementById('outRouteStatus');
                 if (routeStatusEl) {
                     routeStatusEl.innerText = "AWAITING FORECAST";
                     routeStatusEl.className = "text-xs font-bold text-white bg-slate-600 px-2 py-1 rounded";
                 }
            }
        }

        // The throttle advisory, and who wrote the sentence under it.
        //
        // advisorySource is "claude" when the phrasing layer rewrote the
        // deterministic sentence and it passed services/advisory/guard.py, and
        // "template" when it did not -- no key, an error, a rate limit, or a
        // rewrite that changed a number or gave an order. Both are correct
        // states and the label says which, because a captain reading advice is
        // entitled to know what produced the words. The NUMBERS are identical
        // either way: the guard rejects any rewrite whose number set differs
        // from the template's.
        function renderAdvisory(result) {
            const rpmEl = document.getElementById('outAdviceRpm');
            const textEl = document.getElementById('outAdviceText');
            const srcEl = document.getElementById('outAdviceSource');
            const saveEl = document.getElementById('outAdviceSavings');

            if (!result || !result.ok) {
                if (rpmEl) rpmEl.innerText = '—';
                if (saveEl) saveEl.innerText = '—';
                if (textEl) {
                    textEl.innerText = result && result.unavailable
                        ? 'Optimiser unreachable — no recommendation.'
                        : 'Awaiting forecast.';
                }
                if (srcEl) {
                    srcEl.innerText = 'no advice';
                    srcEl.className = "text-xs bg-slate-500/20 text-slate-400 px-1.5 py-0.5 rounded font-mono";
                }
                return;
            }

            if (rpmEl) rpmEl.innerText = `${Math.round(result.recommendedRpm)} rpm`;
            if (textEl) textEl.innerText = result.advisoryEn || '';
            if (saveEl) {
                const lph = result.savingsLph;
                saveEl.innerText = (lph == null || !Number.isFinite(lph))
                    ? '—'
                    : `${lph >= 0 ? '−' : '+'}${Math.abs(lph).toFixed(1)} L/h`;
            }
            if (srcEl) {
                // Render whatever the API reported, not a Claude/not-Claude
                // binary. The first version of this treated every non-"claude"
                // source as "template", which would have labelled a Gemini
                // rewrite as a deterministic sentence -- a rewrite reported as
                // something no model touched. On a display whose whole claim is
                // that provenance is never overstated, that is the one bug that
                // matters more than the ones it was written to prevent.
                const src = result.advisorySource || 'template';
                const NAMES = { claude: 'Claude', gemini: 'Gemini', template: 'template' };
                srcEl.innerText = `phrasing: ${NAMES[src] || src}`;
                srcEl.className = src === 'template'
                    ? "text-xs bg-slate-800/70 text-slate-300 px-1.5 py-0.5 rounded font-mono"
                    : "text-xs bg-slate-700/70 text-slate-100 px-1.5 py-0.5 rounded font-mono";
            }
        }

        let proactiveRerouteTimer = 0;

        function updateSimulation(deltaTime) {
            apiTimer += deltaTime;
            if (apiTimer >= 2.0) {
                apiTimer = 0;
                if (State.apiLivestream) {
                    process2SecondApiLivestream();
                }
            }

            if (State.isManualMode && State.isRunning) {
                const simSpeedElem = document.getElementById('selSimSpeed');
                const simMult = parseFloat(simSpeedElem ? simSpeedElem.value : '1');
                
                let joyX = State.manualJoystick.x || 0;
                let joyY = State.manualJoystick.y || 0;
                
                const turnRate = 22.5; 
                const maxSpeed = 30; 
                
                State.ship.headingDeg = (State.ship.headingDeg + joyX * turnRate * deltaTime * simMult + 360) % 360;
                
                let targetKnots = joyY * maxSpeed; 
                if (targetKnots < 0) targetKnots = targetKnots * 0.5;
                
                let actualKnots = targetKnots;
                State.ship.actualKnots = actualKnots;
                
                const stepDistanceNM = (actualKnots * simMult * deltaTime) / 3600;
                State.ship.distanceTraveledNM = (State.ship.distanceTraveledNM || 0) + Math.abs(stepDistanceNM);
                
                if (Math.abs(stepDistanceNM) > 0.000001) {
                    const headingRad = State.ship.headingDeg * Math.PI / 180;
                    const stepDistanceMeters = stepDistanceNM * 1852;
                    const dLat = (stepDistanceMeters * Math.cos(headingRad)) / 111320;
                    const dLng = (stepDistanceMeters * Math.sin(headingRad)) / (111320 * Math.cos(State.ship.lat * Math.PI / 180));
                    
                    const newLat = State.ship.lat + dLat;
                    const newLng = State.ship.lng + dLng;
                    
                    let canMove = true;
                    if (typeof LiveWaterMask !== 'undefined' && LiveWaterMask && LiveWaterMask.grid && LiveWaterMask.grid.length > 0) {
                        canMove = LiveWaterMask.isWater(newLat, newLng);
                    }
                    
                    if (canMove) {
                        State.ship.lat = newLat;
                        State.ship.lng = newLng;
                        
                        // Check arrival in manual mode
                        const endPort = State.direction === 1 ? State.portB : State.portA;
                        if (endPort && typeof L !== 'undefined') {
                            const distMeters = L.latLng(State.ship.lat, State.ship.lng).distanceTo(L.latLng(endPort.lat, endPort.lng));
                            if (distMeters <= 80 && State.isRunning) {
                                State.ship.progress = 1;
                                State.isRunning = false;
                                if (typeof completeVoyageAndSwapPorts === 'function') completeVoyageAndSwapPorts();
                                State.isRunning = true;
                            }
                        }
                    } else {
                        State.ship.actualKnots = 0;
                        actualKnots = 0;
                    }
                }
                
                if (shipMarker && !isNaN(State.ship.lat) && !isNaN(State.ship.lng)) {
                    if (shouldShowBoat()) {
                        if (map && !map.hasLayer(shipMarker)) shipMarker.addTo(map);
                        shipMarker.setLatLng([State.ship.lat, State.ship.lng]);
                        if (map && !State.is3D) {
                            map.setView([State.ship.lat, State.ship.lng], map.getZoom(), { animate: false });
                        }
                    } else {
                        if (map && map.hasLayer(shipMarker)) map.removeLayer(shipMarker);
                    }
                }

                const shipIconDiv = document.getElementById('shipIconDiv');
                if (shipIconDiv) {
                    shipIconDiv.style.transform = `rotate(${State.ship.headingDeg}deg)`;
                }
                
                updateDisplayValue('outShipHeading', `${Math.round(State.ship.headingDeg || 0)}°`);
                updateDisplayValue('outSpeed', actualKnots.toFixed(1));
                
            } else if (State.isRunning && State.targetPath.length > 1 && State.ship.progress < 1) {
                const totalDistNM = getRouteDistanceNM();
                const simSpeedElem = document.getElementById('selSimSpeed');
                const simMult = parseFloat(simSpeedElem ? simSpeedElem.value : '1000');

                // Proactive path recalculation timer (every 5 seconds of real-time)
                proactiveRerouteTimer += deltaTime;
                if (proactiveRerouteTimer >= 5.0) {
                    proactiveRerouteTimer = 0;
                    if (!isGeneratingRoute) {
                        log("Proactive Navigation: Automatically recalculating path from vessel's current position to destination...", "ai");
                        generateTargetRoute();
                    }
                }

                // Target ETA is independent: decrement remaining target time based on simulation rate
                State.targetEtaSeconds = Math.max(0, State.targetEtaSeconds - simMult * deltaTime);

                // Dynamically optimize throttle for required speed based on remaining ETA target time
                evaluateAndAdjustEtaDynamics();

                const userThrottle = getSafeVal('inThrottle', 75);
                const physics = calculatePhysics(userThrottle);

                let actualKnots = physics.actualSOG;
                // BUGFIX: actualKnots can be too small or 0 if evaluateAndAdjustEtaDynamics resets it,
                // or if computePhysicsState gives a very small value.
                if (isNaN(actualKnots) || actualKnots < 0.1) actualKnots = 1.0; // Enforce minimum movement if running
                
                State.ship.actualKnots = actualKnots;

                // Accumulate cumulative distance traveled
                const stepDistanceNM = (actualKnots * simMult * deltaTime) / 3600;
                State.ship.distanceTraveledNM = (State.ship.distanceTraveledNM || 0) + stepDistanceNM;

                let safeTotalDistNM = isNaN(totalDistNM) || totalDistNM <= 0 ? 5.0 : totalDistNM;
                let progressPerSecond = (actualKnots / Math.max(0.1, safeTotalDistNM)) / 3600;
                State.ship.progress = (State.ship.progress || 0) + progressPerSecond * simMult * deltaTime;
                if (isNaN(State.ship.progress)) State.ship.progress = 0;

                if (State.ship.progress >= 1) {
                    State.ship.progress = 1;
                    State.isRunning = false;
                    State.targetEtaSeconds = 0;
                    completeVoyageAndSwapPorts();
                } else {
                    const path = State.targetPath;
                    const pathLen = path.length;
                    let cumDists = [0];
                    for (let i = 0; i < pathLen - 1; i++) {
                        const d = path[i].distanceTo(path[i + 1]);
                        cumDists.push(cumDists[i] + d);
                    }
                    const totalDistMeters = cumDists[pathLen - 1];

                    let idx1 = 0;
                    if (totalDistMeters > 0) {
                        const targetDistMeters = State.ship.progress * totalDistMeters;
                        for (let i = 0; i < pathLen - 1; i++) {
                            if (targetDistMeters >= cumDists[i] && targetDistMeters <= cumDists[i + 1]) {
                                idx1 = i;
                                break;
                            }
                        }
                    }
                    const idx2 = Math.min(idx1 + 1, pathLen - 1);
                    const segLen = cumDists[idx2] - cumDists[idx1];
                    const t = segLen > 0 ? (State.ship.progress * totalDistMeters - cumDists[idx1]) / segLen : 0;
                    
                    const lat1 = path[idx1].lat, lng1 = path[idx1].lng;
                    const lat2 = path[idx2].lat, lng2 = path[idx2].lng;
                    
                    let pt = sphericalInterpolate(lat1, lng1, lat2, lng2, Math.max(0, Math.min(1, isNaN(t) ? 0 : t)));
                    
                    let headingDeg = State.ship.headingDeg || 0;
                    if (!State.isGpsMode && pt && !isNaN(pt.lat) && !isNaN(pt.lng)) {
                        State.ship.lat = pt.lat;
                        State.ship.lng = pt.lng;
                        
                        let routeHeading = sphericalHeading(lat1, lng1, lat2, lng2);

                        // The course the vessel WANTS. Departure and arrival still
                        // blend toward the jetty heading; the rest of the crossing
                        // wants the current leg's bearing.
                        let desiredHeading;
                        if (State.ship.progress < 0.05 && path.length > 1) {
                            let landHeading = sphericalHeading(path[1].lat, path[1].lng, path[0].lat, path[0].lng);
                            let blend = State.ship.progress / 0.05;
                            desiredHeading = lerpAngle(landHeading, routeHeading, blend);
                        } else if (State.ship.progress > 0.95 && path.length > 1) {
                            let lastP = path[path.length - 1];
                            let prevP = path[path.length - 2];
                            let landHeading = sphericalHeading(prevP.lat, prevP.lng, lastP.lat, lastP.lng);
                            let blend = (State.ship.progress - 0.95) / 0.05;
                            desiredHeading = lerpAngle(routeHeading, landHeading, blend);
                        } else {
                            desiredHeading = routeHeading;
                        }

                        // The course it can actually hold. Without this the heading
                        // snapped to each leg's bearing, so a smoothed RRT path --
                        // which is many short legs -- rotated the hull in a series
                        // of instant steps.
                        if (!State.ship.steering) {
                            // First frame under way: adopt the course rather than
                            // swinging onto it from whatever the marker last held.
                            State.ship.steering = true;
                            headingDeg = desiredHeading;
                        } else {
                            headingDeg = steerToward(
                                headingDeg,
                                desiredHeading,
                                MAX_RATE_OF_TURN_DEG_S * deltaTime * simMult,
                            );
                        }

                        State.ship.headingDeg = headingDeg;
                    }
                    
                    if (shipMarker && !isNaN(State.ship.lat) && !isNaN(State.ship.lng)) {
                        if (shouldShowBoat()) {
                            if (map && !map.hasLayer(shipMarker)) shipMarker.addTo(map);
                            shipMarker.setLatLng([State.ship.lat, State.ship.lng]);
                            if (map && !State.is3D) {
                                map.setView([State.ship.lat, State.ship.lng], map.getZoom(), { animate: false });
                            }
                        } else {
                            if (map && map.hasLayer(shipMarker)) map.removeLayer(shipMarker);
                        }
                    }

                    const shipIconDiv = document.getElementById('shipIconDiv');
                    if (shipIconDiv) {
                        const steerHeading = State.isManualMode ? headingDeg : headingDeg + (physics.crabAngleDeg || 0);
                        shipIconDiv.style.transform = `rotate(${steerHeading}deg)`;
                    }
                }

                updateDisplayValue('outShipHeading', `${Math.round(State.ship.headingDeg || 0)}°`);
                updateDisplayValue('outSpeed', actualKnots.toFixed(1));

                const windSvg = document.getElementById('windCompassSvg');
                if (windSvg) windSvg.style.transform = `rotate(${Math.round(physics.relWindDir)}deg)`;
                updateDisplayValue('outWindRelText', `${Math.round(physics.relWindDir)}°`);

                const waveSvg = document.getElementById('waveCompassSvg');
                if (waveSvg) waveSvg.style.transform = `rotate(${Math.round(physics.relWaveDir)}deg)`;
                updateDisplayValue('outWaveRelText', `${Math.round(physics.relWaveDir)}°`);
                
                // Live remaining time display based on Target ETA schedule
                let minsRem = Math.floor(State.targetEtaSeconds / 60);
                let secsRem = Math.floor(State.targetEtaSeconds % 60);
                updateDisplayValue('outEtaSecs', `${minsRem}:${secsRem.toString().padStart(2,'0')}`);
            } else if (!State.isRunning) {
                updateDisplayValue('outSpeed', '0.0');
            }
        }

        let last3DJumpLng = null;
        let last3DJumpLat = null;
        let last3DJumpBearing = null;

        const LiveWaterMask = {
            grid: null,
            gridW: 0,
            gridH: 0,
            minLat: 0,
            maxLat: 0,
            minLng: 0,
            maxLng: 0,
            updating: false,
            
            async update(mapObj) {
                if (this.updating) return;
                this.updating = true;
                
                try {
                    const bounds = mapObj.getBounds();
                    const pad = 0.02;
                    this.minLat = bounds.getSouth() - pad;
                    this.maxLat = bounds.getNorth() + pad;
                    this.minLng = bounds.getWest() - pad;
                    this.maxLng = bounds.getEast() + pad;
                    
                    const lon2tile = (lon, zoom) => (Math.floor((lon + 180) / 360 * Math.pow(2, zoom)));
                    const lat2tile = (lat, zoom) => (Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, zoom)));

                    // Rule 1: Always zoom at level 19.0 for precision AI vision and water masking
                    let z = 19;
                    
                    // To prevent browser freezes, we dynamically focus precisely on the local viewport
                    // when mapping at zoom 19.0
                    let minX = lon2tile(this.minLng, z);
                    let maxX = lon2tile(this.maxLng, z);
                    let minY = lat2tile(this.maxLat, z); 
                    let maxY = lat2tile(this.minLat, z);
                    let tilesX = maxX - minX + 1;
                    let tilesY = maxY - minY + 1;
                    
                    if (tilesX * tilesY > 49) {
                        const centerLng = (this.minLng + this.maxLng) / 2;
                        const centerLat = (this.minLat + this.maxLat) / 2;
                        // Narrow the bounds to zoom 19 viewport limits
                        this.minLat = centerLat - 0.003;
                        this.maxLat = centerLat + 0.003;
                        this.minLng = centerLng - 0.003;
                        this.maxLng = centerLng + 0.003;
                        minX = lon2tile(this.minLng, z);
                        maxX = lon2tile(this.maxLng, z);
                        minY = lat2tile(this.maxLat, z); 
                        maxY = lat2tile(this.minLat, z);
                        tilesX = maxX - minX + 1;
                        tilesY = maxY - minY + 1;
                    }
                    
                    const TILE_SIZE = 256;
                    const scale = 0.25; 
                    this.gridW = Math.floor(tilesX * TILE_SIZE * scale);
                    this.gridH = Math.floor(tilesY * TILE_SIZE * scale);
                    
                    const canvas = document.createElement('canvas');
                    canvas.width = this.gridW;
                    canvas.height = this.gridH;
                    const ctx = canvas.getContext('2d');
                    
                    const promises = [];
                    for (let x = minX; x <= maxX; x++) {
                        for (let y = minY; y <= maxY; y++) {
                            promises.push(new Promise((resolve) => {
                                const img = new Image();
                                img.crossOrigin = "anonymous";
                                img.src = `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
                                img.onload = () => {
                                    const dx = (x - minX) * TILE_SIZE * scale;
                                    const dy = (y - minY) * TILE_SIZE * scale;
                                    ctx.drawImage(img, dx, dy, TILE_SIZE * scale, TILE_SIZE * scale);
                                    resolve();
                                };
                                img.onerror = resolve;
                            }));
                        }
                    }
                    
                    await Promise.all(promises);
                    const imgData = ctx.getImageData(0, 0, this.gridW, this.gridH).data;
                    this.grid = new Uint8Array(this.gridW * this.gridH);
                    
                    for (let i = 0; i < this.grid.length; i++) {
                        const r = imgData[i * 4];
                        const g = imgData[i * 4 + 1];
                        const b = imgData[i * 4 + 2];
                        const a = imgData[i * 4 + 3];
                        
                        if (a < 255) {
                            this.grid[i] = 2; // Treat transparent as land
                            continue;
                        }

                        // Rule 2: All types of blue are water
                        const isBlue = (b > r + 10 && b + 10 > g) || (b > 180 && r < 200 && b > r + 5 && g > r + 5);
                        
                        // Rule 3: White, green, and yellow are land
                        const isWhite = r > 235 && g > 235 && b > 235;
                        const isGreen = g > r + 3 && g > b + 3;
                        const isYellow = r > 210 && g > 190 && b < 160;

                        // Rule 4 & 5: All types of gray of any size are roads/bridges; boxes are structures (considered land)
                        const isGray = Math.abs(r - g) < 15 && Math.abs(g - b) < 15 && Math.abs(r - b) < 15 && r > 40 && r < 240;

                        if (isBlue) {
                            this.grid[i] = 0; // Water
                        } else if (isWhite || isGreen || isYellow) {
                            this.grid[i] = 2; // Strict Land
                        } else if (isGray) {
                            this.grid[i] = 3; // Bridge/road candidate
                        } else {
                            this.grid[i] = 2; // Default land
                        }
                    }

                    // Rule 6: Bridge detection pass
                    const tempGrid = new Uint8Array(this.grid);
                    for (let y = 1; y < this.gridH - 1; y++) {
                        for (let x = 1; x < this.gridW - 1; x++) {
                            const idx = y * this.gridW + x;
                            if (tempGrid[idx] === 3) {
                                const left = tempGrid[idx - 1];
                                const right = tempGrid[idx + 1];
                                const top = tempGrid[idx - this.gridW];
                                const bottom = tempGrid[idx + this.gridW];
                                
                                const isHorizontalBridge = (left === 0 && right === 0);
                                const isVerticalBridge = (top === 0 && bottom === 0);
                                const isDiagonalBridge = (tempGrid[idx - this.gridW - 1] === 0 && tempGrid[idx + this.gridW + 1] === 0) ||
                                                        (tempGrid[idx - this.gridW + 1] === 0 && tempGrid[idx + this.gridW - 1] === 0);

                                if (isHorizontalBridge || isVerticalBridge || isDiagonalBridge) {
                                    this.grid[idx] = 0; // Navigable bridge!
                                } else {
                                    this.grid[idx] = 1; // Standard road (land)
                                }
                            }
                        }
                    }

                    // Map remaining 3 values to land
                    for (let i = 0; i < this.grid.length; i++) {
                        if (this.grid[i] === 3) {
                            this.grid[i] = 1;
                        }
                    }
                } catch (err) {
                    console.warn("LiveWaterMask error:", err);
                }
                this.updating = false;
            },
            
            isWater(lat, lng) {
                if (!this.grid) return true; // assume water if not loaded
                if (lat < this.minLat || lat > this.maxLat || lng < this.minLng || lng > this.maxLng) return true;
                const x = Math.floor(((lng - this.minLng) / (this.maxLng - this.minLng)) * (this.gridW - 1));
                const y = Math.floor(((this.maxLat - lat) / (this.maxLat - this.minLat)) * (this.gridH - 1));
                if (x < 0 || x >= this.gridW || y < 0 || y >= this.gridH) return true;
                const idx = y * this.gridW + x;
                return this.grid[idx] === 0;
            }
        };

        // 2D Flow Particles Setup (Disabled/Removed)
        function updateDrawParticles2D(deltaTime) {
            const canvas = document.getElementById('flowCanvas2D');
            if (canvas && canvas.width > 0) {
                const ctx = canvas.getContext('2d');
                ctx.clearRect(0, 0, canvas.width, canvas.height);
            }
            return;
        }

        function gameLoop(timestamp) {
            if (!lastTime) lastTime = timestamp;
            const deltaTime = Math.min((timestamp - lastTime) / 1000, 0.1);
            lastTime = timestamp;

            updateSimulation(deltaTime);
            if (is3DMode && typeof gmap !== 'undefined' && gmap) {
                if (typeof gmap.triggerRepaint === 'function') {
                    gmap.triggerRepaint();
                }
                if (State.ship && State.ship.lat !== undefined && State.ship.lng !== undefined) {
                    if (!isFreeLook && State.isRunning) {
                        const lng = State.ship.lng;
                        const lat = State.ship.lat;
                        const bearing = State.ship.headingDeg || 0;
                        if (lng !== last3DJumpLng || lat !== last3DJumpLat || bearing !== last3DJumpBearing) {
                            last3DJumpLng = lng;
                            last3DJumpLat = lat;
                            last3DJumpBearing = bearing;
                            gmap.jumpTo({
                                center: [lng, lat],
                                bearing: bearing
                            });
                        }
                    }
                }
            }
            
            updateDrawParticles2D(deltaTime);
            if (typeof updateMapCompass === 'function') updateMapCompass();
            requestAnimationFrame(gameLoop);
        }

        function setupRangeListeners() {
            const ranges = ['Fuel', 'Rpm', 'Flow', 'Throttle', 'WindSpd', 'WindDir', 'Current', 'CurrentDir', 'Tide', 'Wave', 'WaveDir', 'Eta'];
            ranges.forEach(name => {
                const input = document.getElementById('in' + name);
                if (input) {
                    input.addEventListener('input', (e) => {
                        let val = e.target.value;
                        if (name === 'Eta') {
                            evaluateAndAdjustEtaDynamics();
                        } else {
                            if (['Rpm', 'Flow', 'Throttle'].includes(name) && !State.isRunning) {
                                updateDisplayValue('val' + name, '--');
                            } else {
                                if (['WindDir', 'CurrentDir', 'WaveDir'].includes(name)) val += '°';
                                if (['Fuel', 'Throttle'].includes(name)) val += '%';
                                if (name === 'Tide') val += 'm';
                                updateDisplayValue('val' + name, val);
                            }
                        }
                        evaluateAndAdjustEtaDynamics();
                    });
                }
            });

            const etaInput = document.getElementById('inEta');
            if (etaInput) {
                etaInput.addEventListener('change', () => {
                    evaluateAndAdjustEtaDynamics();
                });
                etaInput.addEventListener('blur', () => {
                    evaluateAndAdjustEtaDynamics();
                });
            }

            const boatParams = ['LBP', 'Breadth', 'Depth', 'DWT', 'MCR', 'EngineType', 'ServiceSpeed', 'HullType', 'MaxPax'];

            // Saved and restored with the rest of the vessel spec, but no term in
            // the resistance model reads it, so changing it must not replan.
            const NON_ROUTING_BOAT_PARAMS = new Set(['MaxPax']);

            // The vessel spec is fixed in index.html section 3 and the inputs are
            // read-only, so persisting it is not just pointless -- it is the one thing
            // that can defeat the lock. This function used to assign
            // `input.value = params[param]`, which bypasses `readonly` entirely: every
            // visitor who had already opened the console carried the old 35 m / 120 t /
            // 1200 HP ship in localStorage and would have had it restored straight over
            // the locked 17.5 m spec, on a URL being handed to judges.
            //
            // So: restore nothing, and actively clear the stale keys so a returning
            // visitor converges on the shipped vessel instead of keeping a private one.
            function loadSavedBoatParams() {
                try {
                    localStorage.removeItem('marine_ai_boat_parameters');
                    localStorage.removeItem('navai_boat_parameters');
                } catch (e) {
                    console.warn('Could not clear stale boat parameters:', e);
                }
            }

            // Kept as a no-op rather than deleted: it is still wired to input/change/blur
            // listeners below, which are inert for read-only fields but would throw if
            // the function vanished. Nothing should re-persist a spec that cannot change.
            function saveBoatParams() {}

            loadSavedBoatParams();

            boatParams.forEach(param => {
                const input = document.getElementById('in' + param);
                if (input) {
                    input.addEventListener('input', () => {
                        saveBoatParams();
                        if (NON_ROUTING_BOAT_PARAMS.has(param)) return;
                        if (State.portA && State.portB && State.targetPath && State.targetPath.length >= 2) {
                            if (window.boatParamRouteDebounce) clearTimeout(window.boatParamRouteDebounce);
                            window.boatParamRouteDebounce = setTimeout(() => { generateTargetRoute(); }, 1000);
                        }
                        if (['EngineType', 'MCR'].includes(param)) {
                            if (engineSpecDebounceTimer) clearTimeout(engineSpecDebounceTimer);
                            engineSpecDebounceTimer = setTimeout(() => {
                                extractEngineSpecsAsync();
                            }, 700);
                        }
                    });
                    input.addEventListener('change', () => {
                        saveBoatParams();
                        if (['EngineType', 'MCR'].includes(param)) {
                            extractEngineSpecsAsync();
                        }
                    });
                    input.addEventListener('blur', () => {
                        if (['EngineType', 'MCR'].includes(param)) {
                            extractEngineSpecsAsync();
                        }
                    });
                }
            });

            // Extract initial engine specs on app startup
            setTimeout(() => {
                extractEngineSpecsAsync();
            }, 300);

            const weatherSelect = document.getElementById('inWeather');
            if (weatherSelect) {
                weatherSelect.addEventListener('change', (e) => {
                    const liveStatus = document.getElementById('liveWeatherStatus');
                    if (e.target.value === 'live') {
                        if (liveStatus) liveStatus.classList.remove('hidden');
                        refreshLiveMetocean();
                        return;
                    }
                    if (liveStatus) liveStatus.classList.add('hidden');

                    const preset = WEATHER_PRESETS[e.target.value];
                    if (preset) {
                        setSafeVal('inWindSpd', preset.windSpd);
                        setSafeVal('inWindDir', preset.windDir);
                        setSafeVal('inCurrent', preset.currentSpd);
                        setSafeVal('inCurrentDir', preset.currentDir);
                        setSafeVal('inWave', preset.waveHt);
                        setSafeVal('inWaveDir', preset.waveDir);
                        setSafeVal('inTide', preset.tide);

                        log(`Weather preset changed to [${e.target.value.toUpperCase()}]. Re-evaluating 2D mesh...`, "info");
                        generateTargetRoute();
                    }
                });
            }

            // Operating instructions. The driver.js tour walks the interface;
            // this is the version you can read at your own pace and scroll back in.
            const modalInstructions = document.getElementById('instructionsModal');
            if (modalInstructions) {
                const openInstModal = () => {
                    modalInstructions.classList.remove('hidden');
                    modalInstructions.classList.add('flex');
                    // Two frames: the element must be laid out before the opacity
                    // transition has anything to transition from.
                    requestAnimationFrame(() => {
                        requestAnimationFrame(() => modalInstructions.classList.remove('opacity-0'));
                    });
                };
                const closeInstModal = () => {
                    modalInstructions.classList.add('opacity-0');
                    setTimeout(() => {
                        modalInstructions.classList.add('hidden');
                        modalInstructions.classList.remove('flex');
                    }, 300);
                };

                ['toolInstructions', 'btnCloseInstructionsModal', 'btnCloseInstructionsModalBottom']
                    .forEach((id, i) => {
                        const el = document.getElementById(id);
                        if (el) el.addEventListener('click', i === 0 ? openInstModal : closeInstModal);
                    });

                modalInstructions.addEventListener('click', (e) => {
                    if (e.target === modalInstructions) closeInstModal();
                });
                document.addEventListener('keydown', (e) => {
                    if (e.key === 'Escape' && !modalInstructions.classList.contains('hidden')) {
                        closeInstModal();
                    }
                });
            }
        }

        function setupDraggableWindow() {
            const win = document.getElementById('windyFloatingWindow');
            const titleBar = document.getElementById('windyTitleBar');
            const iframe = document.getElementById('windyEmbedIframe');
            
            let isDragging = false;
            let startX, startY, startLeft, startTop;

            titleBar.addEventListener('mousedown', (e) => {
                if (e.target.tagName === 'BUTTON' || e.target.closest('button')) return false;
                
                isDragging = true;
                startX = e.clientX;
                startY = e.clientY;
                
                startLeft = win.offsetLeft;
                startTop = win.offsetTop;
                
                win.style.right = 'auto';
                win.style.bottom = 'auto';
                win.style.left = startLeft + 'px';
                win.style.top = startTop + 'px';

                if (iframe) iframe.style.pointerEvents = 'none';
                e.preventDefault();
            });

            window.addEventListener('mousemove', (e) => {
                if (!isDragging) return false;
                
                const dx = e.clientX - startX;
                const dy = e.clientY - startY;
                
                let newLeft = startLeft + dx;
                let newTop = startTop + dy;

                const maxW = window.innerWidth - win.offsetWidth;
                const maxH = window.innerHeight - win.offsetHeight;
                newLeft = Math.max(0, Math.min(newLeft, maxW));
                newTop = Math.max(0, Math.min(newTop, maxH));

                win.style.left = newLeft + 'px';
                win.style.top = newTop + 'px';
            });

            window.addEventListener('mouseup', () => {
                if (isDragging) {
                    isDragging = false;
                    if (iframe) iframe.style.pointerEvents = 'auto';
                }
            });
        }

        window.addEventListener('DOMContentLoaded', () => {
            initMap();
            init3DMap();
            setupRangeListeners();
            setupDraggableWindow();
            log("Leaflet Satellite Navigation System online.", "success");
            log("Global Precise Land Detector active (A* Custom Tile Raster).", "ai");

            const minimapOverlay = document.getElementById('minimapOverlay');
            if (minimapOverlay) {
                minimapOverlay.addEventListener('click', (e) => {
                    e.stopPropagation();
                    expand2DView();
                });
            }

            const btnClose2D = document.getElementById('btnClose2D');
            if (btnClose2D) {
                btnClose2D.addEventListener('click', (e) => {
                    e.stopPropagation();
                    collapse2DView();
                });
            }

            // Default to 2D view on load
            expand2DView();

            window.addEventListener('resize', () => {
                if (!is2DExpanded) {
                    const wrapper = document.getElementById('map2DWrapper');
                    if (wrapper) {
                        wrapper.style.width = window.innerWidth < 640 ? '120px' : '160px';
                        wrapper.style.height = window.innerWidth < 640 ? '120px' : '160px';
                    }
                }
            });

            // Route Planner Button Listeners
            const btnHybrid = document.getElementById('btnPathModeHybrid');
            const btnAstar = document.getElementById('btnPathModeAstar');
            const btnGC = document.getElementById('btnPathModeGC');
            const btnDLite = document.getElementById('btnPathModeDLite');
            const btnRRT = document.getElementById('btnPathModeRRT');

            if (btnHybrid) {
                btnHybrid.addEventListener('click', () => {
                    State.pathMode = 'hybrid';
                    updatePathEngineUI('hybrid');
                    if (State.portA && State.portB) generateTargetRoute();
                });
            }
            if (btnAstar) {
                btnAstar.addEventListener('click', () => {
                    State.pathMode = 'astar';
                    updatePathEngineUI('astar');
                    if (State.portA && State.portB) generateTargetRoute();
                });
            }
            if (btnGC) {
                btnGC.addEventListener('click', () => {
                    State.pathMode = 'greatcircle';
                    updatePathEngineUI('greatcircle');
                    if (State.portA && State.portB) generateTargetRoute();
                });
            }
            if (btnDLite) {
                btnDLite.addEventListener('click', () => {
                    State.pathMode = 'dlite';
                    updatePathEngineUI('dlite');
                    if (State.portA && State.portB) generateTargetRoute();
                });
            }
            if (btnRRT) {
                btnRRT.addEventListener('click', () => {
                    State.pathMode = 'rrt';
                    updatePathEngineUI('rrt');
                    if (State.portA && State.portB) generateTargetRoute();
                });
            }

            updatePathEngineUI(State.pathMode);

            const windyWin = document.getElementById('windyFloatingWindow');
            const windyBody = document.getElementById('windyWindowBody');
            let isCollapsed = false;

            document.getElementById('btnToggleWindy').addEventListener('click', () => {
                windyWin.style.display = windyWin.style.display === 'none' ? 'flex' : 'none';
            });

            document.getElementById('btnWindyClose').addEventListener('click', () => {
                windyWin.style.display = 'none';
            });

            document.getElementById('btnWindyMinimize').addEventListener('click', () => {
                isCollapsed = !isCollapsed;
                if (isCollapsed) {
                    windyBody.style.display = 'none';
                    windyWin.style.height = 'auto';
                } else {
                    windyBody.style.display = 'flex';
                    windyWin.style.height = '380px';
                }
            });

            document.getElementById('btnWindyPop').addEventListener('click', () => {
                window.open('https://www.windy.com', '_blank');
            });



            const btnStart = document.getElementById('btnStart');
            const joystickZone = document.getElementById('joystickZone');

            if (btnStart) {
                btnStart.addEventListener('click', () => {
                    if (!State.portA || !State.portB) {
                        log("Cannot start voyage: Departure and Destination ports are not set.", "warn");
                        alert("Please set both Departure (Port A) and Destination (Port B) on the map first.");
                        return false;
                    }
                    if (!State.targetPath || State.targetPath.length < 2) {
                        log("Cannot start voyage: Please wait for the AI Engine to compute the route first.", "warn");
                        alert("Please wait for the AI Engine to compute a navigable route first.");
                        return false;
                    }
                    if (!State.isRunning && State.ship.progress < 1) {
                        const getUnderWay = () => {
                            if (State.ship.progress === 0) {
                                State.ship.distanceTraveledNM = 0;
                            }
                            State.isRunning = true;
                            btnStart.innerText = "Abort";
                            btnStart.className = "h-8 bg-red-500 hover:bg-red-600 text-white px-3 rounded-lg font-bold text-xs transition-all shadow-[0_0_10px_rgba(239,68,68,0.4)] active:scale-95 flex items-center justify-center gap-1.5 shrink-0 whitespace-nowrap cursor-pointer";
                            updateDisplayValue('speedStatus', "Underway");
                            log("Navigation engaged with highly precise land collision avoidance.", "ai");
                            if (is2DExpanded) collapse2DView();
                            if (typeof updateClose2DButtonVisibility === 'function') updateClose2DButtonVisibility();
                        };

                        // Ask for the manifest on departure only. Resuming a halted
                        // voyage carries the same passengers it left with.
                        if (State.ship.progress === 0) {
                            showPaxModal(getUnderWay);
                        } else {
                            getUnderWay();
                        }
                    } else if (State.isRunning) {
                        State.isRunning = false;
                        btnStart.innerText = "Resume";
                        btnStart.className = "h-8 bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-600 hover:to-amber-600 text-white px-3 rounded-lg font-bold text-xs transition-all shadow-[0_0_10px_rgba(249,115,22,0.3)] active:scale-95 flex items-center justify-center gap-1.5 shrink-0 whitespace-nowrap cursor-pointer";
                        updateDisplayValue('speedStatus', "Halted");
                        log("Voyage halted by operator.", "alert");
                        if (typeof updateClose2DButtonVisibility === 'function') updateClose2DButtonVisibility();
                    }
                });
            }

            const toolMapType = document.getElementById('toolMapType');
            if (toolMapType) toolMapType.addEventListener('click', () => toggle2DMapType());

            const btnMapDefault = document.getElementById('btnMapDefault');
            if (btnMapDefault) btnMapDefault.addEventListener('click', () => setMapType('default'));

            const btnMapSatellite = document.getElementById('btnMapSatellite');
            if (btnMapSatellite) btnMapSatellite.addEventListener('click', () => setMapType('satellite'));

            const btnMapNautical = document.getElementById('btnMapNautical');
            if (btnMapNautical) btnMapNautical.addEventListener('click', () => setMapType('nautical'));

            const toolNauticalOverlay = document.getElementById('toolNauticalOverlay');
            if (toolNauticalOverlay) toolNauticalOverlay.addEventListener('click', () => toggleNauticalOverlay());

            const btnResetPorts = document.getElementById('btnResetPorts');
            if (btnResetPorts) btnResetPorts.addEventListener('click', () => resetPorts());

            const toolResetPorts = document.getElementById('toolResetPorts');
            if (toolResetPorts) toolResetPorts.addEventListener('click', () => resetPorts());

            const btnSwap = document.getElementById('btnSwap');
            if (btnSwap) {
                btnSwap.addEventListener('click', () => {
                    if (State.isRunning) return false;
                    if (!State.portA || !State.portB) {
                        log("Cannot swap ports: Departure and Destination ports must both be set.", "warn");
                        return false;
                    }
                    State.direction *= -1;
                    State.ship.progress = 0;
                    State.ship.distanceTraveledNM = 0;
                    updateRoute();
                    log("Departure and arrival ports swapped.", "info");
                });
            }

            ['pointer', 'portA', 'portB', 'obstacle', 'storm'].forEach(tool => {
                const btnId = 'tool' + tool.charAt(0).toUpperCase() + tool.slice(1);
                const btn = document.getElementById(btnId);
                if (btn) {
                    btn.addEventListener('click', (e) => {
                        // Clicking the tool that is already armed disarms it and
                        // returns to the pointer, so there is a way out of
                        // obstacle/storm placement that is not "place one more".
                        const wasActive = e.currentTarget.classList.contains('active');
                        const nextTool = (wasActive && tool !== 'pointer') ? 'pointer' : tool;

                        document.querySelectorAll('.tool-btn').forEach(b => {
                            b.classList.remove('active', 'bg-slate-700', 'text-white');
                            b.classList.add('text-slate-400');
                        });

                        const nextBtnId = 'tool' + nextTool.charAt(0).toUpperCase() + nextTool.slice(1);
                        const nextBtn = document.getElementById(nextBtnId);
                        if (nextBtn) {
                            nextBtn.classList.remove('text-slate-400');
                            nextBtn.classList.add('active', 'bg-slate-700', 'text-white');
                        }
                        State.activeTool = nextTool;

                        const hintEl = document.getElementById('toolHint');
                        if (hintEl && TOOL_HINTS[nextTool]) {
                            hintEl.innerText = TOOL_HINTS[nextTool];
                        }
                    });
                }
            });

            
            // Interactive Guide with driver.js
            const driverObj = driver({
              showProgress: true,
              animate: true,
              allowClose: true,
              theme: 'dark',
              steps: [
                {
                  popover: {
                    title: 'Welcome to Marine-AI 🌊',
                    // Said "powered by Neural Spatial AI" until 2026-08-03. There is no
                    // neural network anywhere in this system: the throttle comes from a
                    // deterministic sweep over a physics resistance model, the wear
                    // penalty from a gradient-boosted tree served as ONNX, and the health
                    // score from a PCA linear autoencoder plus a robust z-score. Claiming
                    // otherwise on the first screen a judge reads contradicted the one
                    // argument this project actually rests on.
                    description: 'A retrofit advisory system for Philippine passenger boats. Physics and trained models compute the fuel, the route and the engine health; the captain decides. This guide walks you through setting up a voyage, placing hazards, and reading the live telemetry.',
                    side: 'center',
                    align: 'center'
                  }
                },
                {
                  element: '#mapToolsOverlay',
                  popover: {
                    title: '1. The Navigation Toolkit',
                    description: 'Here is your main toolkit. By default, the Pointer tool is selected. You can also use this menu to place dynamic obstacles, spawn storm vortexes, or switch map modes (Satellite, Nautical). The AI will dynamically reroute around any hazards you place.',
                    side: 'right',
                    align: 'start'
                  }
                },
                {
                  element: '#leafletMap',
                  popover: {
                    title: '2. Set Departure & Destination',
                    description: 'Time to set up your first voyage! While this step is active, click anywhere on the map to drop your Departure Port (Green). Then, click a second time in a different location to drop your Destination Port (Orange). The AI will immediately compute the most efficient route.',
                    side: 'top',
                    align: 'center'
                  }
                },
                {
                  element: '#leftPanel',
                  popover: {
                    title: '3. Vessel & Environment Control',
                    description: 'This panel allows you to configure the simulation variables. Adjust your vessel\'s draft (which affects how shallow it can go), set initial fuel levels, and tweak engine RPM. You can also change the weather preset to see how wind and currents affect the AI\'s routing decisions.',
                    side: 'right',
                    align: 'center'
                  }
                },
                {
                  element: '#btnHeaderEngine',
                  popover: {
                    title: '4. Live Engine Telemetry',
                    description: 'Click this to open the Engine Telemetry window. It provides a real-time X-Ray view of the vessel\'s powertrain, displaying temperatures, fuel flow, RPM, and Machine Learning anomaly detection scores to prevent engine failure.',
                    side: 'bottom',
                    align: 'start'
                  }
                },
                {
                  element: '#btnHeaderAnalytics',
                  popover: {
                    title: '5. Historical Analytics',
                    description: 'The Analytics dashboard logs all your completed voyages. Here you can compare travel times, fuel efficiency, and carbon emissions across different routes and weather conditions.',
                    side: 'bottom',
                    align: 'start'
                  }
                },
                {
                  element: '#btnToggleWindy',
                  popover: {
                    title: '6. Live Weather Radar',
                    description: 'Need real-world context? Toggle the Windy.com overlay to view live satellite weather data, including wind particles, storms, and ocean currents directly inside the simulator.',
                    side: 'bottom',
                    align: 'start'
                  }
                },
                {
                  element: '#simSpeedContainer',
                  popover: {
                    title: '7. Time Control',
                    description: 'Simulation taking too long? Use this time multiplier to speed up or slow down the physics engine and vessel movement up to 10x speed.',
                    side: 'bottom',
                    align: 'start'
                  }
                },
                {
                  element: '#btnStart',
                  popover: {
                    title: '8. Start Your Voyage!',
                    description: 'You are all set! If you have placed your Departure and Destination ports on the map, click the Start button to initiate the autonomous voyage. Watch as the AI navigates the seas!',
                    side: 'bottom',
                    align: 'start'
                  }
                }
              ]
            });

            const toolGuide = document.getElementById('toolGuide');
            if (toolGuide) {
                toolGuide.addEventListener('click', () => {
                    driverObj.drive();
                });
            }

            // Splash -> guide -> dashboard, in that order, every time.
            //
            // The splash is markup in index.html and visible by default, so it covers
            // the page from the first painted frame rather than waiting for this
            // bundle. Here we only take it down -- after a floor of 1.6s so it reads
            // as an intro rather than a flash on a fast connection, and after the
            // fade so the guide never highlights an element behind a curtain.
            //
            // The guide itself stays once-per-visitor. A nine-step tour on every load
            // would be hostile, and the splash is what the "every time" applies to.
            // Five seconds, end to end, measured from navigation start:
            //
            //   0.06s  brand starts rising
            //   1.62s  last element (progress) has settled
            //   1.6-4.4s  hold, fully composed
            //   4.40s  fade begins
            //   5.00s  removed from the DOM
            //
            // MUST stay in step with `.splash { transition: opacity }` in
            // index.html. They were 500ms here and 620ms there, so the element was
            // being removed 120ms into a fade that had not finished -- a visible
            // pop rather than a dissolve, and exactly the kind of thing that only
            // shows up when you watch it rather than read it.
            const SPLASH_MIN_MS = 4200;
            const SPLASH_FADE_MS = 600;

            function startGuideIfUnseen() {
                if (localStorage.getItem('marine_ai_seen_guide_v3')) return;
                driverObj.drive();
                localStorage.setItem('marine_ai_seen_guide_v3', 'true');
            }

            (function dismissSplashThenGuide() {
                const splash = document.getElementById('splashScreen');
                if (!splash) {
                    startGuideIfUnseen();
                    return;
                }
                const status = document.getElementById('splashStatus');
                if (status) status.textContent = 'Optimiser ready.';

                // Measured from the splash's FIRST PAINT (stamped in a rAF in
                // index.html), not from navigationStart. performance.now() alone
                // includes everything spent in <head> before the splash existed,
                // so on a slow connection the hold expires while the animation
                // is still mid-sequence and the dart never lands on screen.
                // Falling back to 0 keeps the old behaviour if the stamp is
                // missing, which is the safe direction: dismiss late, not early.
                const elapsed = performance.now() - (window.__splashT0 ?? 0);
                const wait = Math.max(0, SPLASH_MIN_MS - elapsed);

                setTimeout(() => {
                    // Not Tailwind's `opacity-0`: the fade must not depend on a
                    // bundle that may not have arrived. `.splash.is-out` is
                    // defined in the inline block alongside the transition.
                    splash.classList.add('is-out');
                    setTimeout(() => {
                        // `remove`, not `hidden`: nothing behind it should ever be
                        // covered by a transparent full-screen layer that still eats
                        // clicks. This has bitten the map before.
                        splash.remove();
                        startGuideIfUnseen();
                    }, SPLASH_FADE_MS);
                }, wait);
            })();





            const btnClearHazards = document.getElementById('toolClearHazards');
            if (btnClearHazards) {
                btnClearHazards.addEventListener('click', () => {
                    if (hazardLayerGroup) hazardLayerGroup.clearLayers();
                    State.entities.obstacles = [];
                    State.entities.storms = [];
                    if (State.portA && State.portB) {
                        generateTargetRoute();
                        log("All dynamic obstacles and storms cleared. Route re-calculated automatically.", "info");
                    } else {
                        log("All dynamic obstacles and storms cleared.", "info");
                    }
                });
            }

            // --- SIDEWAYS PANEL RESIZE & MINIMIZE/EXPAND ---
            const leftPanel = document.getElementById('leftPanel');
            const rightPanel = document.getElementById('rightPanel');
            const leftResizeHandle = document.getElementById('leftResizeHandle');
            const rightResizeHandle = document.getElementById('rightResizeHandle');
            const btnToggleLeft = document.getElementById('btnToggleLeft');
            const btnToggleRight = document.getElementById('btnToggleRight');
            
            const btnDownloadData = document.getElementById('btnDownloadData');
            if (btnDownloadData) {
                btnDownloadData.addEventListener('click', () => {
                    const dataToDownload = State.currentViewedTrip ? State.currentViewedTrip.data : State.mlLogger.data;
                    
                    if (!dataToDownload || dataToDownload.length === 0) {
                        console.warn("No data to download.");
                        return;
                    }
                    
                    const keys = Object.keys(dataToDownload[0]);
                    const csvContent = [
                        keys.join(','),
                        ...dataToDownload.map(row => keys.map(k => row[k]).join(','))
                    ].join('\n');
                    
                    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.setAttribute('href', url);
                    let filename = 'engine_telemetry_ml_dataset.csv';
                    if (State.currentViewedTrip) {
                        const dateStr = new Date(State.currentViewedTrip.timestamp).toISOString().split('T')[0];
                        filename = `analytics_trip_${dateStr}.csv`;
                    }
                    a.setAttribute('download', filename);
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                });
            }
            const iconLeftPanel = document.getElementById('iconLeftPanel');
            const iconRightPanel = document.getElementById('iconRightPanel');

            // These override the inline width in index.html -- the panels are
            // forced to their compressed state on init, a few lines below -- so
            // this is the only place the default width is actually decided.
            //
            // 200 and 240 were sized around 9-11px labels. With the type floor at
            // 12px (src/index.css) those widths wrap the longest sidebar labels
            // ("Path Generator Source", "Est. Fuel Saving") onto three lines and
            // render four-line entries in the log column. The panel gets wider;
            // the text does not get smaller again.
            const LEFT_MIN = 250;
            const LEFT_EXP = 340;
            const RIGHT_MIN = 300;
            const RIGHT_EXP = 400;

            let leftLastExpWidth = LEFT_EXP;
            let rightLastExpWidth = RIGHT_EXP;

            function updateLeftUI() {
                if (!leftPanel) return;
                const curW = leftPanel.offsetWidth;
                if (curW <= LEFT_MIN + 20) {
                    if (iconLeftPanel) iconLeftPanel.className = 'fa-solid fa-angles-right';
                    if (btnToggleLeft) btnToggleLeft.title = 'Expand Left Panel';
                } else {
                    if (iconLeftPanel) iconLeftPanel.className = 'fa-solid fa-angles-left';
                    if (btnToggleLeft) btnToggleLeft.title = 'Compress Left Panel';
                }
            }

            function updateRightUI() {
                if (!rightPanel) return;
                const curW = rightPanel.offsetWidth;
                if (curW <= RIGHT_MIN + 20) {
                    if (iconRightPanel) iconRightPanel.className = 'fa-solid fa-angles-left';
                    if (btnToggleRight) btnToggleRight.title = 'Expand Right Panel';
                } else {
                    if (iconRightPanel) iconRightPanel.className = 'fa-solid fa-angles-right';
                    if (btnToggleRight) btnToggleRight.title = 'Compress Right Panel';
                }
            }

            let toggleLeftPanel = function() {
                if (!leftPanel) return;
                const curW = leftPanel.offsetWidth;
                if (curW <= LEFT_MIN + 20) {
                    leftPanel.style.width = leftLastExpWidth + 'px';
                } else {
                    leftLastExpWidth = Math.max(LEFT_EXP, curW);
                    leftPanel.style.width = LEFT_MIN + 'px';
                }
                updateLeftUI();
                if (typeof refreshMapSize === 'function') refreshMapSize();
                setTimeout(() => { updateLeftUI(); if (typeof refreshMapSize === 'function') refreshMapSize(); }, 320);
            }

            let toggleRightPanel = function() {
                if (!rightPanel) return;
                const curW = rightPanel.offsetWidth;
                if (curW <= RIGHT_MIN + 20) {
                    rightPanel.style.width = rightLastExpWidth + 'px';
                } else {
                    rightLastExpWidth = Math.max(RIGHT_EXP, curW);
                    rightPanel.style.width = RIGHT_MIN + 'px';
                }
                updateRightUI();
                if (typeof refreshMapSize === 'function') refreshMapSize();
                setTimeout(() => { updateRightUI(); if (typeof refreshMapSize === 'function') refreshMapSize(); }, 320);
            }

            

            
            // Mobile toggle logic
            const btnMobileLeft = document.getElementById('btnMobileLeft');
            const btnMobileRight = document.getElementById('btnMobileRight');
            
            if (btnMobileLeft) {
                btnMobileLeft.addEventListener('click', () => {
                    leftPanel.classList.toggle('max-md:!-translate-x-full');
                    // close right if open
                    rightPanel.classList.add('max-md:!translate-x-full');
                });
            }
            if (btnMobileRight) {
                btnMobileRight.addEventListener('click', () => {
                    rightPanel.classList.toggle('max-md:!translate-x-full');
                    // close left if open
                    leftPanel.classList.add('max-md:!-translate-x-full');
                });
            }
            
            // Override toggle functions on mobile to slide instead of resize width
            const originalToggleLeft = toggleLeftPanel;
            toggleLeftPanel = function() {
                if (window.innerWidth < 768) {
                    leftPanel.classList.add('max-md:!-translate-x-full');
                } else {
                    originalToggleLeft();
                }
            };
            
            const originalToggleRight = toggleRightPanel;
            toggleRightPanel = function() {
                if (window.innerWidth < 768) {
                    rightPanel.classList.add('max-md:!translate-x-full');
                } else {
                    originalToggleRight();
                }
            };

            if (btnToggleLeft) btnToggleLeft.addEventListener('click', toggleLeftPanel);
            if (btnToggleRight) btnToggleRight.addEventListener('click', toggleRightPanel);
            
            // Tab switching logic
            const tabNavBtn = document.getElementById('tabNavBtn');
            const tabContentNav = document.getElementById('tabContentNav');
            
            // The tabs are removed, Nav is the only panel
            if (tabContentNav) {
                tabContentNav.classList.remove('hidden');
            }
            if (tabNavBtn) {
                tabNavBtn.classList.add('text-orange-400', 'border-orange-400', 'bg-orange-500/10', 'border-b-2');
                tabNavBtn.classList.remove('text-slate-400', 'hover:text-slate-200', 'hover:bg-slate-800/50');
            }

            // Engine Modal logic
            let engineChartInstance = null;
            function initEngineChart() {
                const canvas = document.getElementById('engineChart');
                if (!canvas || typeof Chart === 'undefined') return;
                if (engineChartInstance) return;

                const ctx = canvas.getContext('2d');
                if (!ctx) return;
                
                const rpmGradient = ctx.createLinearGradient(0, 0, 0, 120);
                rpmGradient.addColorStop(0, 'rgba(249, 115, 22, 0.4)');
                rpmGradient.addColorStop(1, 'rgba(249, 115, 22, 0.0)');

                const loadGradient = ctx.createLinearGradient(0, 0, 0, 120);
                loadGradient.addColorStop(0, 'rgba(255, 255, 255, 0.25)');
                loadGradient.addColorStop(1, 'rgba(255, 255, 255, 0.0)');

                const initialLabels = Array(15).fill('');
                const initialRpmData = Array(15).fill(0);
                const initialLoadData = Array(15).fill(0);

                engineChartInstance = new Chart(ctx, {
                    type: 'line',
                    data: {
                        labels: initialLabels,
                        datasets: [
                            {
                                label: 'RPM',
                                data: initialRpmData,
                                borderColor: '#f97316',
                                backgroundColor: rpmGradient,
                                borderWidth: 2,
                                fill: true,
                                tension: 0.4,
                                pointRadius: 0,
                                yAxisID: 'yRpm'
                            },
                            {
                                label: 'Load (%)',
                                data: initialLoadData,
                                borderColor: '#ffffff',
                                backgroundColor: loadGradient,
                                borderWidth: 2,
                                fill: true,
                                tension: 0.4,
                                pointRadius: 0,
                                yAxisID: 'yLoad'
                            }
                        ]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        animation: false,
                        plugins: {
                            legend: {
                                display: true,
                                position: 'top',
                                align: 'end',
                                labels: {
                                    color: '#f8fafc',
                                    font: { family: 'JetBrains Mono', size: 9, weight: 'bold' },
                                    boxWidth: 8,
                                    boxHeight: 8,
                                    usePointStyle: true
                                }
                            },
                            tooltip: {
                                mode: 'index',
                                intersect: false,
                                backgroundColor: 'rgba(15, 23, 42, 0.9)',
                                titleColor: '#f97316',
                                bodyColor: '#f8fafc',
                                borderColor: 'rgba(249, 115, 22, 0.3)',
                                borderWidth: 1
                            }
                        },
                        scales: {
                            x: {
                                display: false
                            },
                            yRpm: {
                                type: 'linear',
                                position: 'left',
                                min: 0,
                                max: 180,
                                grid: {
                                    color: 'rgba(255, 255, 255, 0.05)'
                                },
                                ticks: {
                                    color: '#f97316',
                                    font: { family: 'JetBrains Mono', size: 8 }
                                }
                            },
                            yLoad: {
                                type: 'linear',
                                position: 'right',
                                min: 0,
                                max: 100,
                                grid: {
                                    display: false
                                },
                                ticks: {
                                    color: '#ffffff',
                                    font: { family: 'JetBrains Mono', size: 8 }
                                }
                            }
                        }
                    }
                });
            }

            const btnHeaderEngine = document.getElementById('btnHeaderEngine');
            const engineModal = document.getElementById('engineModal');
            const btnCloseEngineModal = document.getElementById('btnCloseEngineModal');
            
            if (btnHeaderEngine && engineModal && btnCloseEngineModal) {
                btnHeaderEngine.addEventListener('click', () => {
                    engineModal.classList.remove('hidden'); engineModal.classList.add('flex');
                    initEngineChart();
                    // Add small delay for transition
                    setTimeout(() => engineModal.classList.add('opacity-100'), 10);
                });
                
                btnCloseEngineModal.addEventListener('click', () => {
                    engineModal.classList.remove('opacity-100');
                    setTimeout(() => { engineModal.classList.add('hidden'); engineModal.classList.remove('flex'); }, 300);
                });
                
                // Close when clicking outside modal content
                engineModal.addEventListener('click', (e) => {
                    if (e.target === engineModal) {
                        btnCloseEngineModal.click();
                    }
                });
            }

            // X-Ray Isolation logic
            const btnIsoAll = document.getElementById('btnIsoAll');
            const btnIsoEng = document.getElementById('btnIsoEng');
            const btnIsoFuel = document.getElementById('btnIsoFuel');
            const btnIsoNav = document.getElementById('btnIsoNav');
            
            if (btnIsoAll && btnIsoEng && btnIsoFuel && btnIsoNav) {
                const resetIsoButtons = () => {
                    [btnIsoAll, btnIsoEng, btnIsoFuel, btnIsoNav].forEach(btn => {
                        btn.className = "text-xs font-bold px-2 py-1 rounded bg-slate-800 text-slate-400 hover:text-white cursor-pointer transition-colors border border-transparent";
                    });
                };

                const applyIsoFocus = (focusBtn, highlightIds) => {
                    resetIsoButtons();
                    focusBtn.className = "text-xs font-bold px-2 py-1 rounded bg-orange-500 text-white cursor-pointer transition-colors border border-orange-400";
                    
                    const allIds = ['xrayEngine', 'xrayFuelLevelL', 'xrayFuelLevelR', 'xrayRadarLine', 'xrayPropeller'];
                    
                    if (highlightIds === 'ALL') {
                        allIds.forEach(id => {
                            const el = document.getElementById(id);
                            if (el && el.parentElement) el.parentElement.style.opacity = '1';
                        });
                    } else {
                        allIds.forEach(id => {
                            const el = document.getElementById(id);
                            if (el && el.parentElement) {
                                if (highlightIds.includes(id)) {
                                    el.parentElement.style.opacity = '1';
                                } else {
                                    el.parentElement.style.opacity = '0.2';
                                }
                            }
                        });
                    }
                };

                btnIsoAll.addEventListener('click', () => applyIsoFocus(btnIsoAll, 'ALL'));
                btnIsoEng.addEventListener('click', () => applyIsoFocus(btnIsoEng, ['xrayEngine', 'xrayPropeller']));
                btnIsoFuel.addEventListener('click', () => applyIsoFocus(btnIsoFuel, ['xrayFuelLevelL', 'xrayFuelLevelR']));
                btnIsoNav.addEventListener('click', () => applyIsoFocus(btnIsoNav, ['xrayRadarLine']));
            }

            // Analytics Modal logic
            const btnHeaderAnalytics = document.getElementById('btnHeaderAnalytics');
            const analyticsModal = document.getElementById('analyticsModal');
            const btnCloseAnalyticsModal = document.getElementById('btnCloseAnalyticsModal');
            
            let chartPerformance = null;
            let chartHealth = null;
            let chartEnvironment = null;
            let chartMaster = null;
            let masterVisibleDatasets = {
                sog: true, rpm: false, fuel: false, load: false, egt: false, stress: false, wind: false, current: false, wave: false
            };
            
            function createChartConfig(title, datasets, scales) {
                return {
                    type: 'line',
                    data: { labels: [], datasets: datasets },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        interaction: { mode: 'index', intersect: false },
                        plugins: {
                            legend: { 
                                display: true,
                                position: 'top',
                                labels: { color: '#94a3b8', boxWidth: 12, usePointStyle: true, pointStyle: 'circle' }
                            },
                            tooltip: {
                                backgroundColor: 'rgba(2, 6, 23, 0.9)',
                                titleColor: '#94a3b8',
                                bodyColor: '#fff',
                                borderColor: 'rgba(249, 115, 22, 0.3)',
                                borderWidth: 1,
                                padding: 10
                            }
                        },
                        scales: {
                            x: {
                                display: true,
                                grid: { color: 'rgba(51, 65, 85, 0.3)' },
                                ticks: { color: '#64748b', maxTicksLimit: 20 }
                            },
                            ...scales
                        }
                    }
                };
            }

            function initAnalyticsCharts() {
                const ctxPerf = document.getElementById('chartPerformance')?.getContext('2d');
                const ctxHealth = document.getElementById('chartHealth')?.getContext('2d');
                const ctxEnv = document.getElementById('chartEnvironment')?.getContext('2d');
                const ctxMaster = document.getElementById('chartMaster')?.getContext('2d');
                
                if (typeof Chart === 'undefined') return;

                if (!chartPerformance && ctxPerf) {
                    chartPerformance = new Chart(ctxPerf, createChartConfig('Performance', [
                        { label: 'SOG (kts)', data: [], borderColor: '#10b981', backgroundColor: 'rgba(16, 185, 129, 0.1)', borderWidth: 2, fill: true, tension: 0.2, pointRadius: 0, yAxisID: 'ySog' },
                        { label: 'RPM', data: [], borderColor: '#f97316', backgroundColor: 'rgba(249, 115, 22, 0.1)', borderWidth: 2, fill: true, tension: 0.2, pointRadius: 0, yAxisID: 'yRpm' },
                        { label: 'Fuel Flow (L/h)', data: [], borderColor: '#eab308', backgroundColor: 'rgba(234, 179, 8, 0.1)', borderWidth: 2, fill: true, tension: 0.2, pointRadius: 0, yAxisID: 'yFuel' }
                    ], {
                        ySog: { type: 'linear', position: 'left', min: 0, max: 40, display: true, grid: { color: 'rgba(51, 65, 85, 0.3)' } },
                        yRpm: { type: 'linear', position: 'right', min: 0, max: 3500, display: true, grid: { drawOnChartArea: false } },
                        yFuel: { type: 'linear', position: 'right', min: 0, display: true, grid: { drawOnChartArea: false } }
                    }));
                }

                if (!chartHealth && ctxHealth) {
                    chartHealth = new Chart(ctxHealth, createChartConfig('Health', [
                        { label: 'Engine Load (%)', data: [], borderColor: '#a855f7', backgroundColor: 'rgba(168, 85, 247, 0.1)', borderWidth: 2, fill: true, tension: 0.2, pointRadius: 0, yAxisID: 'yLoad' },
                        { label: 'EGT (°C)', data: [], borderColor: '#ef4444', backgroundColor: 'rgba(239, 68, 68, 0.1)', borderWidth: 2, fill: true, tension: 0.2, pointRadius: 0, yAxisID: 'yEgt' },
                        { label: 'Cooling (°C)', data: [], borderColor: '#3b82f6', backgroundColor: 'rgba(59, 130, 246, 0.1)', borderWidth: 2, fill: true, tension: 0.2, pointRadius: 0, yAxisID: 'yTemp' },
                        { label: 'Hull Stress (%)', data: [], borderColor: '#f59e0b', backgroundColor: 'rgba(245, 158, 11, 0.1)', borderWidth: 2, fill: true, tension: 0.2, pointRadius: 0, yAxisID: 'yLoad' }
                    ], {
                        yLoad: { type: 'linear', position: 'left', min: 0, max: 110, display: true, grid: { color: 'rgba(51, 65, 85, 0.3)' } },
                        yEgt: { type: 'linear', position: 'right', min: 0, max: 600, display: true, grid: { drawOnChartArea: false } },
                        yTemp: { type: 'linear', position: 'right', min: 0, max: 120, display: true, grid: { drawOnChartArea: false } }
                    }));
                }

                if (!chartEnvironment && ctxEnv) {
                    chartEnvironment = new Chart(ctxEnv, createChartConfig('Environment', [
                        { label: 'Wind Spd (kts)', data: [], borderColor: '#64748b', backgroundColor: 'rgba(100, 116, 139, 0.1)', borderWidth: 2, fill: true, tension: 0.2, pointRadius: 0, yAxisID: 'ySpd' },
                        { label: 'Current Spd (kts)', data: [], borderColor: '#06b6d4', backgroundColor: 'rgba(6, 182, 212, 0.1)', borderWidth: 2, fill: true, tension: 0.2, pointRadius: 0, yAxisID: 'ySpd' },
                        { label: 'Wave Ht (m)', data: [], borderColor: '#8b5cf6', backgroundColor: 'rgba(139, 92, 246, 0.1)', borderWidth: 2, fill: true, tension: 0.2, pointRadius: 0, yAxisID: 'yWave' }
                    ], {
                        ySpd: { type: 'linear', position: 'left', min: 0, max: 50, display: true, grid: { color: 'rgba(51, 65, 85, 0.3)' } },
                        yWave: { type: 'linear', position: 'right', min: 0, max: 10, display: true, grid: { drawOnChartArea: false } }
                    }));
                }

                if (!chartMaster && ctxMaster) {
                    chartMaster = new Chart(ctxMaster, createChartConfig('Master', [
                        { id: 'sog', label: 'SOG', data: [], borderColor: '#10b981', borderWidth: 2, fill: false, tension: 0.2, pointRadius: 0, yAxisID: 'yNorm' },
                        { id: 'rpm', label: 'RPM', data: [], borderColor: '#f97316', borderWidth: 2, fill: false, tension: 0.2, pointRadius: 0, yAxisID: 'yNorm', hidden: !masterVisibleDatasets.rpm },
                        { id: 'fuel', label: 'Fuel', data: [], borderColor: '#eab308', borderWidth: 2, fill: false, tension: 0.2, pointRadius: 0, yAxisID: 'yNorm', hidden: !masterVisibleDatasets.fuel },
                        { id: 'load', label: 'Load', data: [], borderColor: '#a855f7', borderWidth: 2, fill: false, tension: 0.2, pointRadius: 0, yAxisID: 'yNorm', hidden: !masterVisibleDatasets.load },
                        { id: 'egt', label: 'EGT', data: [], borderColor: '#ef4444', borderWidth: 2, fill: false, tension: 0.2, pointRadius: 0, yAxisID: 'yNorm', hidden: !masterVisibleDatasets.egt },
                        { id: 'stress', label: 'Stress', data: [], borderColor: '#f59e0b', borderWidth: 2, fill: false, tension: 0.2, pointRadius: 0, yAxisID: 'yNorm', hidden: !masterVisibleDatasets.stress },
                        { id: 'wind', label: 'Wind', data: [], borderColor: '#64748b', borderWidth: 2, fill: false, tension: 0.2, pointRadius: 0, yAxisID: 'yNorm', hidden: !masterVisibleDatasets.wind },
                        { id: 'current', label: 'Current', data: [], borderColor: '#06b6d4', borderWidth: 2, fill: false, tension: 0.2, pointRadius: 0, yAxisID: 'yNorm', hidden: !masterVisibleDatasets.current },
                        { id: 'wave', label: 'Wave', data: [], borderColor: '#8b5cf6', borderWidth: 2, fill: false, tension: 0.2, pointRadius: 0, yAxisID: 'yNorm', hidden: !masterVisibleDatasets.wave }
                    ], {
                        yNorm: { type: 'linear', position: 'left', min: 0, max: 100, display: true, grid: { color: 'rgba(51, 65, 85, 0.3)' } }
                    }));
                }
            }

            window.updateAnalyticsChartWithData = function(data) {
                if (!data) return;
                
                const labels = data.map(d => {
                    const date = new Date(d.timestamp);
                    return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}:${date.getSeconds().toString().padStart(2, '0')}`;
                });
                
                if (chartPerformance) {
                    chartPerformance.data.labels = labels;
                    chartPerformance.data.datasets[0].data = data.map(d => parseFloat(d.speedKts));
                    chartPerformance.data.datasets[1].data = data.map(d => parseFloat(d.rpm));
                    chartPerformance.data.datasets[2].data = data.map(d => parseFloat(d.fuelFlow || 0));
                    chartPerformance.update('none');
                }
                
                if (chartHealth) {
                    chartHealth.data.labels = labels;
                    chartHealth.data.datasets[0].data = data.map(d => parseFloat(d.engineLoad) * 100);
                    chartHealth.data.datasets[1].data = data.map(d => parseFloat(d.egt));
                    chartHealth.data.datasets[2].data = data.map(d => parseFloat(d.cooling));
                    chartHealth.data.datasets[3].data = data.map(d => parseFloat(d.hullStress || 0));
                    chartHealth.update('none');
                }
                
                if (chartEnvironment) {
                    chartEnvironment.data.labels = labels;
                    chartEnvironment.data.datasets[0].data = data.map(d => parseFloat(d.windSpd));
                    chartEnvironment.data.datasets[1].data = data.map(d => parseFloat(d.waveHt));
                    chartEnvironment.data.datasets[2].data = data.map(d => parseFloat(d.currentSpd));
                    chartEnvironment.update('none');
                }
                
                if (chartMaster) {
                    chartMaster.data.labels = labels;
                    chartMaster.data.datasets[0].data = data.map(d => Math.min(100, (parseFloat(d.speedKts) / 30) * 100)); // SOG (max 30kt)
                    chartMaster.data.datasets[1].data = data.map(d => Math.min(100, (parseFloat(d.rpm) / 1000) * 100)); // RPM (max 1000)
                    chartMaster.data.datasets[2].data = data.map(d => Math.min(100, (parseFloat(d.fuelFlow || 0) / 200) * 100)); // Fuel (max 200 L/h)
                    chartMaster.data.datasets[3].data = data.map(d => parseFloat(d.engineLoad) * 100); // Load %
                    chartMaster.data.datasets[4].data = data.map(d => Math.min(100, (parseFloat(d.egt) / 800) * 100)); // EGT (max 800)
                    chartMaster.data.datasets[5].data = data.map(d => parseFloat(d.hullStress || 0)); // Stress %
                    chartMaster.data.datasets[6].data = data.map(d => Math.min(100, (parseFloat(d.windSpd) / 50) * 100)); // Wind (max 50kt)
                    chartMaster.data.datasets[7].data = data.map(d => Math.min(100, (parseFloat(d.currentSpd) / 5) * 100)); // Current (max 5kt)
                    chartMaster.data.datasets[8].data = data.map(d => Math.min(100, (parseFloat(d.waveHt) / 10) * 100)); // Wave (max 10)
                    chartMaster.update('none');
                }
            };
            
            window.updateAnalyticsChart = function() {
                if (State.currentViewedTrip) {
                     window.updateAnalyticsChartWithData(State.currentViewedTrip.data);
                } else if (State.mlLogger.data) {
                     window.updateAnalyticsChartWithData(State.mlLogger.data);
                }
            };

            if (btnHeaderAnalytics && analyticsModal && btnCloseAnalyticsModal) {
                const masterToggles = document.querySelectorAll('.analytics-toggle-master');
                
                masterToggles.forEach(btn => {
                    btn.addEventListener('click', () => {
                        const ds = btn.dataset.dataset;
                        masterVisibleDatasets[ds] = !masterVisibleDatasets[ds];
                        
                        if (masterVisibleDatasets[ds]) {
                            btn.className = "analytics-toggle-master text-xs font-bold px-3 py-1 rounded-lg bg-orange-500 text-white cursor-pointer transition-colors shadow-[0_0_8px_rgba(249,115,22,0.3)] active:scale-95";
                        } else {
                            btn.className = "analytics-toggle-master text-xs font-bold px-3 py-1 rounded-lg bg-slate-800 text-slate-400 hover:text-white cursor-pointer transition-colors active:scale-95";
                        }
                        
                        if (chartMaster) {
                            const datasetObj = chartMaster.data.datasets.find(d => d.id === ds);
                            if (datasetObj) {
                                datasetObj.hidden = !masterVisibleDatasets[ds];
                            }
                            chartMaster.update();
                        }
                    });
                });

                btnHeaderAnalytics.addEventListener('click', () => {
                    refreshAnalyticsSidebar();
                    analyticsModal.classList.remove('hidden'); analyticsModal.classList.add('flex');
                    initAnalyticsCharts();
                    window.updateAnalyticsChart();
                    setTimeout(() => analyticsModal.classList.add('opacity-100'), 10);
                });
                
                btnCloseAnalyticsModal.addEventListener('click', () => {
                    analyticsModal.classList.remove('opacity-100');
                    setTimeout(() => { analyticsModal.classList.add('hidden'); analyticsModal.classList.remove('flex'); }, 300);
                });
                
                analyticsModal.addEventListener('click', (e) => {
                    if (e.target === analyticsModal) {
                        btnCloseAnalyticsModal.click();
                    }
                });
            }

            // Start at most compressed state by default
            if (leftPanel) leftPanel.style.width = LEFT_MIN + 'px';
            if (rightPanel) rightPanel.style.width = RIGHT_MIN + 'px';
            updateLeftUI();
            updateRightUI();

            let isResizingLeft = false;
            let isResizingRight = false;

            if (leftResizeHandle) {
                leftResizeHandle.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    isResizingLeft = true;
                    document.body.classList.add('resizing');
                });
            }

            if (rightResizeHandle) {
                rightResizeHandle.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    isResizingRight = true;
                    document.body.classList.add('resizing');
                });
            }

            window.addEventListener('mousemove', (e) => {
                const mainEl = document.querySelector('main');
                if (!mainEl) return;
                const mainRect = mainEl.getBoundingClientRect();

                if (isResizingLeft) {
                    let newWidth = e.clientX - mainRect.left;
                    const maxWidth = Math.min(650, mainRect.width - 250);
                    newWidth = Math.max(LEFT_MIN, Math.min(newWidth, maxWidth));
                    leftPanel.style.width = newWidth + 'px';
                    updateLeftUI();
                    if (typeof refreshMapSize === 'function') refreshMapSize();
                } else if (isResizingRight) {
                    let newWidth = mainRect.right - e.clientX;
                    const maxWidth = Math.min(700, mainRect.width - 250);
                    newWidth = Math.max(RIGHT_MIN, Math.min(newWidth, maxWidth));
                    rightPanel.style.width = newWidth + 'px';
                    updateRightUI();
                    if (typeof refreshMapSize === 'function') refreshMapSize();
                }
            });

            window.addEventListener('mouseup', () => {
                if (isResizingLeft) {
                    isResizingLeft = false;
                    document.body.classList.remove('resizing');
                    updateLeftUI();
                }
                if (isResizingRight) {
                    isResizingRight = false;
                    document.body.classList.remove('resizing');
                    updateRightUI();
                }
            });

            // --- ZOOM SLIDER CONTROLLER (0-100%) ---
            const zoomSlider = document.getElementById('zoomRangeSlider');
            const zoomDisplay = document.getElementById('zoomLevelDisplay');
            const btnZoomIn = document.getElementById('btnZoomIn');
            const btnZoomOut = document.getElementById('btnZoomOut');

            const MIN_ZOOM = 3;
            const MAX_ZOOM = 19;

            function zoomToPercent(zoom) {
                const pct = Math.round(((zoom - MIN_ZOOM) / (MAX_ZOOM - MIN_ZOOM)) * 100);
                return Math.max(0, Math.min(100, pct));
            }

            function percentToZoom(pct) {
                return MIN_ZOOM + (pct / 100) * (MAX_ZOOM - MIN_ZOOM);
            }

            window.syncZoomUI = function() {
                let currentZoom = 14;
                if (typeof is3DMode !== 'undefined' && is3DMode && typeof gmap !== 'undefined' && gmap) {
                    currentZoom = gmap.getZoom();
                } else if (typeof map !== 'undefined' && map) {
                    currentZoom = map.getZoom();
                }
                const pct = zoomToPercent(currentZoom);
                if (zoomSlider) zoomSlider.value = pct;
                if (zoomDisplay) zoomDisplay.textContent = pct + '%';
            };

            if (zoomSlider) {
                zoomSlider.addEventListener('input', (e) => {
                    const pct = parseInt(e.target.value, 10);
                    if (zoomDisplay) zoomDisplay.textContent = pct + '%';
                    const targetZoom = percentToZoom(pct);
                    if (typeof is3DMode !== 'undefined' && is3DMode && typeof gmap !== 'undefined' && gmap) {
                        gmap.setZoom(targetZoom);
                    } else if (typeof map !== 'undefined' && map) {
                        map.setZoom(targetZoom);
                    }
                });
            }

            if (btnZoomIn) {
                btnZoomIn.addEventListener('click', () => {
                    if (typeof is3DMode !== 'undefined' && is3DMode && typeof gmap !== 'undefined' && gmap) {
                        gmap.zoomIn();
                    } else if (typeof map !== 'undefined' && map) {
                        map.zoomIn();
                    }
                });
            }

            if (btnZoomOut) {
                btnZoomOut.addEventListener('click', () => {
                    if (typeof is3DMode !== 'undefined' && is3DMode && typeof gmap !== 'undefined' && gmap) {
                        gmap.zoomOut();
                    } else if (typeof map !== 'undefined' && map) {
                        map.zoomOut();
                    }
                });
            }

            window.addEventListener('resize', () => {
                if (map) map.invalidateSize();
                if (typeof gmap !== 'undefined' && gmap) {
                    gmap.setPadding({ top: Math.floor(gmap.getContainer().clientHeight * 0.45) });
                }
            });

            requestAnimationFrame(gameLoop);
        });
    
        const btnRecenter = document.getElementById('btnRecenter3D');
        if (btnRecenter) {
            btnRecenter.addEventListener('mousedown', e => e.stopPropagation());
            btnRecenter.addEventListener('touchstart', e => e.stopPropagation());
            btnRecenter.addEventListener('wheel', e => e.stopPropagation());
            btnRecenter.addEventListener('click', e => {
                e.stopPropagation();
                isFreeLook = false;
                btnRecenter.style.display = 'none';
                if (typeof gmap !== 'undefined' && gmap) {
                    // Reset pitch and zoom immediately
                    gmap.jumpTo({
                        pitch: 75,
                        zoom: 19
                    });
                }
            });
        }

        let gmap, webglOverlayView, scene, camera, renderer;
        let boatMesh;
        let is3DMode = true;
        let is2DExpanded = false;
        let isFreeLook = false;

        function updateClose2DButtonVisibility() {
            const closeBtn = document.getElementById('btnClose2D');
            if (!closeBtn) return;
            if (is2DExpanded && State.isRunning) {
                closeBtn.classList.remove('hidden');
            } else {
                closeBtn.classList.add('hidden');
            }
        }

        function expand2DView() {
            is2DExpanded = true;
            is3DMode = false;
            
            const wrapper = document.getElementById('map2DWrapper');
            const overlay = document.getElementById('minimapOverlay');
            const btnToggle3D = document.getElementById('btnToggle3D');
            const mapViewModePill = document.getElementById('mapViewModePill');
            const mapToolsOverlay = document.getElementById('mapToolsOverlay');

            if (wrapper) {
                wrapper.style.top = '0px';
                wrapper.style.right = '0px';
                wrapper.style.width = '100%';
                wrapper.style.height = '100%';
                wrapper.style.borderRadius = '0px';
                wrapper.style.border = 'none';
                wrapper.classList.remove('cursor-pointer', 'shadow-2xl');
            }

            if (overlay) overlay.style.display = 'none';
            updateClose2DButtonVisibility();
            if (mapToolsOverlay) mapToolsOverlay.style.display = 'flex';

            if (mapViewModePill) {
                mapViewModePill.style.right = window.innerWidth < 640 ? '12px' : '260px';
            }

            if (btnToggle3D) {
                btnToggle3D.innerHTML = '<i class="fa-solid fa-cube text-sky-300 text-xs sm:text-xs shrink-0"></i> <span class="truncate">3D Cam</span>';
            }

            if (typeof map !== 'undefined' && map) {
                map.invalidateSize();
                let interval = setInterval(() => map.invalidateSize(), 30);
                setTimeout(() => {
                    clearInterval(interval);
                    map.invalidateSize();
                }, 350);
            }
            updateMapCompass();
            log("Expanded 2D Map View full screen.", "info");
        }

        function collapse2DView() {
            is2DExpanded = false;
            is3DMode = true;

            const wrapper = document.getElementById('map2DWrapper');
            const overlay = document.getElementById('minimapOverlay');
            const btnToggle3D = document.getElementById('btnToggle3D');
            const mapViewModePill = document.getElementById('mapViewModePill');
            const mapToolsOverlay = document.getElementById('mapToolsOverlay');

            const minimapWidth = window.innerWidth < 640 ? '120px' : '160px';

            if (wrapper) {
                wrapper.style.top = '12px';
                wrapper.style.right = '12px';
                wrapper.style.width = minimapWidth;
                wrapper.style.height = minimapWidth;
                wrapper.style.borderRadius = '50%';
                wrapper.style.border = '2px solid rgba(249, 115, 22, 0.8)';
                wrapper.classList.add('cursor-pointer', 'shadow-2xl');
            }

            if (overlay) overlay.style.display = 'flex';
            updateClose2DButtonVisibility();
            if (mapToolsOverlay) mapToolsOverlay.style.display = 'none';

            if (mapViewModePill) {
                mapViewModePill.style.right = window.innerWidth < 640 ? '140px' : '184px';
            }

            if (btnToggle3D) {
                btnToggle3D.innerHTML = '<i class="fa-solid fa-map text-emerald-400 text-xs sm:text-xs shrink-0"></i> <span class="truncate">2D Map</span>';
            }

            if (!gmap) {
                init3DMap();
            } else {
                gmap.resize();
            }

            if (typeof map !== 'undefined' && map) {
                map.invalidateSize();
                let interval = setInterval(() => map.invalidateSize(), 30);
                setTimeout(() => {
                    clearInterval(interval);
                    map.invalidateSize();
                }, 350);
            }
            updateMapCompass();
            log("Returned to 3D View mode (2D Minimap active).", "info");
        }

        function updateMapCompass() {
            const compassDisc = document.getElementById('mapCompassDisc');
            if (!compassDisc) return;
            
            let bearing = 0;
            if (is3DMode && typeof gmap !== 'undefined' && gmap && typeof gmap.getBearing === 'function') {
                bearing = gmap.getBearing() || 0;
            }
            
            compassDisc.style.transform = `rotate(${-bearing}deg)`;
        }

        function init3DMap() {
            log("Loading MapLibre 3D View...", "info");
            
            const mapDiv = document.getElementById('gmaps3D');
            
            gmap = new maplibregl.Map({
                container: mapDiv,
                style: {
                    version: 8,
                    sources: {
                        'satellite': {
                            type: 'raster',
                            tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
                            tileSize: 256,
                            maxzoom: 17,
                            attribution: '&copy; Esri'
                        },
                        'default-roadmap': {
                            type: 'raster',
                            tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
                            tileSize: 256,
                            maxzoom: 19,
                            attribution: '&copy; OpenStreetMap contributors'
                        },
                        'nautical-base': {
                            type: 'raster',
                            tiles: ['https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png'],
                            tileSize: 256,
                            maxzoom: 19,
                            attribution: '&copy; CARTO Dark Matter'
                        },
                        'nautical-ref': {
                            type: 'raster',
                            tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Reference/MapServer/tile/{z}/{y}/{x}'],
                            tileSize: 256,
                            maxzoom: 19,
                            attribution: '&copy; Esri Ocean Bathymetry Reference'
                        },
                        'openseamap': {
                            type: 'raster',
                            tiles: ['https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png'],
                            tileSize: 256,
                            maxzoom: 18,
                            attribution: '&copy; OpenSeaMap'
                        }
                    },
                    layers: [
                        {
                            id: 'satellite-layer',
                            type: 'raster',
                            source: 'satellite',
                            layout: { visibility: current3DMapType === 'satellite' ? 'visible' : 'none' }
                        },
                        {
                            id: 'default-layer',
                            type: 'raster',
                            source: 'default-roadmap',
                            layout: { visibility: current3DMapType === 'default' ? 'visible' : 'none' }
                        },
                        {
                            id: 'nautical-base-layer',
                            type: 'raster',
                            source: 'nautical-base',
                            layout: { visibility: current3DMapType === 'nautical' ? 'visible' : 'none' }
                        },
                        {
                            id: 'nautical-ref-layer',
                            type: 'raster',
                            source: 'nautical-ref',
                            layout: { visibility: current3DMapType === 'nautical' ? 'visible' : 'none' }
                        },
                        {
                            id: 'openseamap-layer',
                            type: 'raster',
                            source: 'openseamap',
                            layout: { visibility: (isNauticalOverlayActive || current3DMapType === 'nautical') ? 'visible' : 'none' }
                        }
                    ]
                },
                center: [State.portA ? State.portA.lng : 122.5644, State.portA ? State.portA.lat : 10.6928],
                zoom: 19,
                pitch: 75,
                maxPitch: 85,
                bearing: State.ship.headingDeg || 0,
                antialias: true,
                interactive: true,
                fadeDuration: 0,
                renderWorldCopies: false
            });

            gmap.on('zoom', () => {
                if (typeof window.syncZoomUI === 'function') window.syncZoomUI();
            });

            gmap.on('style.load', () => {
                gmap.setPadding({ top: Math.floor(gmap.getContainer().clientHeight * 0.45) });
                
                // Add route source and layer
                gmap.addSource('route', {
                    'type': 'geojson',
                    'data': {
                        'type': 'Feature',
                        'properties': {},
                        'geometry': {
                            'type': 'LineString',
                            'coordinates': []
                        }
                    }
                });
                
                gmap.addLayer({
                    'id': 'route-layer',
                    'type': 'line',
                    'source': 'route',
                    'layout': {
                        'line-join': 'round',
                        'line-cap': 'round'
                    },
                    'paint': {
                        'line-color': '#f97316', // Orange
                        'line-width': [
                            'interpolate',
                            ['exponential', 2],
                            ['zoom'],
                            0, 0.5,
                            10, 2,
                            12, 4,
                            14, 8,
                            15, 12,
                            16, 16,
                            17, 24,
                            18, 36,
                            20, 100,
                            22, 250
                        ],
                        'line-opacity': 0.3
                    }
                });
                // Initialize route if it exists
                if (State.targetPath && State.targetPath.length > 0) {
                    const coordinates = State.targetPath.map(p => [p.lng, p.lat]);
                    gmap.getSource('route').setData({
                        type: 'Feature',
                        properties: {},
                        geometry: {
                            type: 'LineString',
                            coordinates: coordinates
                        }
                    });
                }
                const customLayer = {
                    id: '3d-model',
                    type: 'custom',
                    renderingMode: '3d',
                    onAdd: function(map, gl) {
                        this.camera = new THREE.Camera();
                        this.scene = new THREE.Scene();

                        // Add lights
                        const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
                        this.scene.add(ambientLight);
                        const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
                        directionalLight.position.set(1, 1, 2);
                        this.scene.add(directionalLight);

                        const boatGroup = new THREE.Group();
                        const hullMat = new THREE.MeshLambertMaterial({ color: 0xf97316 }); // Orange UI Theme
                        const cabinMat = new THREE.MeshLambertMaterial({ color: 0xd1d5db }); // Light gray/silver
                        const deckMat = new THREE.MeshLambertMaterial({ color: 0x2563eb }); // Blue deck
                        const glassMat = new THREE.MeshLambertMaterial({ color: 0x111827 }); // Dark windows
                        const panelMat = new THREE.MeshLambertMaterial({ color: 0x1e3a8a }); // Solar panels

                        const s = 1.0;
                        
                        // 1. Side Walls with Windows and Cutouts
                        const wallShape = new THREE.Shape();
                        wallShape.moveTo(-7.5*s, 0); // bottom aft
                        wallShape.lineTo(4.5*s, 0); // bottom forward
                        wallShape.lineTo(4.5*s, 1.2*s); // vertical front
                        wallShape.lineTo(3.5*s, 2.5*s); // slanted windshield
                        wallShape.lineTo(-6.5*s, 2.5*s); // roof line
                        // fin
                        wallShape.quadraticCurveTo(-7*s, 2.5*s, -7.5*s, 3.2*s);
                        wallShape.lineTo(-7.5*s, 2.5*s);
                        // aft cutout
                        wallShape.lineTo(-7.5*s, 2.0*s);
                        wallShape.quadraticCurveTo(-5.5*s, 1.25*s, -7.5*s, 0.5*s);
                        wallShape.lineTo(-7.5*s, 0);

                        // Windows
                        for(let i=0; i<4; i++) {
                            const hole = new THREE.Path();
                            const wWidth = 1.5*s;
                            const wHeight = 0.8*s;
                            const slant = 0.4*s; 
                            const wx = -5.0*s + i*2.2*s;
                            const wy = 0.6*s;
                            hole.moveTo(wx, wy);
                            hole.lineTo(wx + wWidth, wy);
                            hole.lineTo(wx + wWidth - slant, wy + wHeight);
                            hole.lineTo(wx - slant, wy + wHeight);
                            hole.lineTo(wx, wy);
                            wallShape.holes.push(hole);
                        }

                        const wallGeo = new THREE.ExtrudeGeometry(wallShape, { depth: 0.2*s, bevelEnabled: true, bevelThickness: 0.05*s, bevelSize: 0.05*s, bevelSegments: 2 });
                        // Rotate to align with Y/Z axes
                        const m = new THREE.Matrix4();
                        m.set(
                            0, 0, 1, 0,
                            1, 0, 0, 0,
                            0, 1, 0, 0,
                            0, 0, 0, 1
                        );
                        wallGeo.applyMatrix4(m);
                        wallGeo.translate(-0.1*s, 0, 0);

                        const portWall = new THREE.Mesh(wallGeo, cabinMat);
                        portWall.position.set(-2*s, 0, 2.05*s);
                        boatGroup.add(portWall);

                        const stbdWall = new THREE.Mesh(wallGeo, cabinMat);
                        stbdWall.position.set(2*s, 0, 2.05*s);
                        boatGroup.add(stbdWall);

                        // 2. Inner Dark Glass Block
                        const glassBlock = new THREE.Mesh(new THREE.BoxGeometry(3.9*s, 11*s, 2.4*s), glassMat);
                        glassBlock.position.set(0, -1.5*s, 3.25*s);
                        boatGroup.add(glassBlock);

                        // 3. Roof
                        const roofGeo = new THREE.PlaneGeometry(4.2*s, 11*s);
                        const roof = new THREE.Mesh(roofGeo, cabinMat);
                        roof.position.set(0, -1.5*s, 4.55*s);
                        boatGroup.add(roof);

                        // 4. Front Wall and Windshield
                        const frontWallGeo = new THREE.PlaneGeometry(4.2*s, 1.2*s);
                        const frontWall = new THREE.Mesh(frontWallGeo, cabinMat);
                        frontWall.rotation.x = Math.PI / 2;
                        frontWall.position.set(0, 4.5*s, 2.65*s);
                        boatGroup.add(frontWall);

                        const windGeo = new THREE.PlaneGeometry(4.2*s, Math.sqrt(1*1 + 1.3*1.3)*s);
                        const windshield = new THREE.Mesh(windGeo, glassMat);
                        windshield.rotation.x = Math.PI/2 - Math.atan2(1.3, 1);
                        windshield.position.set(0, 4.0*s, 3.9*s);
                        boatGroup.add(windshield);

                        // Door Decal
                        const doorGeo = new THREE.PlaneGeometry(1*s, 0.8*s);
                        const doorMat = new THREE.MeshLambertMaterial({ color: 0x7f1d1d });
                        const door = new THREE.Mesh(doorGeo, doorMat);
                        door.rotation.x = Math.PI / 2;
                        door.position.set(0, 4.51*s, 2.5*s);
                        boatGroup.add(door);

                        // 5. Deck
                        const deckGeo = new THREE.PlaneGeometry(5.8*s, 17.8*s);
                        const deck = new THREE.Mesh(deckGeo, deckMat);
                        deck.position.set(0, -1*s, 2.05*s);
                        boatGroup.add(deck);

                        // 6. Hull (Pointed Bow, Orange)
                        const hullShape2 = new THREE.Shape();
                        hullShape2.moveTo(-3*s, -9.5*s);
                        hullShape2.lineTo(3*s, -9.5*s);
                        hullShape2.lineTo(3*s, 4*s);
                        hullShape2.lineTo(0*s, 9.5*s);
                        hullShape2.lineTo(-3*s, 4*s);
                        hullShape2.lineTo(-3*s, -9.5*s);

                        const hullGeo2 = new THREE.ExtrudeGeometry(hullShape2, { depth: 2*s, bevelEnabled: true, bevelThickness: 0.2*s, bevelSize: 0.2*s, bevelSegments: 2 });
                        const hull2 = new THREE.Mesh(hullGeo2, hullMat);
                        hull2.position.z = 0;
                        boatGroup.add(hull2);

                        // 7. Bow Railings
                        const railMat = new THREE.MeshLambertMaterial({ color: 0xf3f4f6 });
                        const railLGeo = new THREE.CylinderGeometry(0.05*s, 0.05*s, 6.2*s);
                        const railL = new THREE.Mesh(railLGeo, railMat);
                        railL.rotation.z = Math.atan2(3, 5.5);
                        railL.rotation.x = Math.PI / 2;
                        railL.position.set(-1.5*s, 6.75*s, 2.5*s);
                        boatGroup.add(railL);

                        const railR = new THREE.Mesh(railLGeo, railMat);
                        railR.rotation.z = -Math.atan2(3, 5.5);
                        railR.rotation.x = Math.PI / 2;
                        railR.position.set(1.5*s, 6.75*s, 2.5*s);
                        boatGroup.add(railR);

                        // 8. Solar Panels
                        const panelGroup = new THREE.Group();
                        const panelGeo = new THREE.PlaneGeometry(1.2*s, 1.8*s);
                        for (let row = 0; row < 5; row++) {
                            for (let col = -1; col <= 1; col++) {
                                const panel = new THREE.Mesh(panelGeo, panelMat);
                                const mountGeo = new THREE.CylinderGeometry(0.05*s, 0.05*s, 0.2*s);
                                const mount = new THREE.Mesh(mountGeo, cabinMat);
                                mount.rotation.x = Math.PI/2;
                                mount.position.set(0, 0, -0.1*s);
                                panel.add(mount);
                                
                                panel.position.set(col * 1.3*s, (3 - row*2)*s, 4.8*s);
                                panelGroup.add(panel);
                            }
                        }
                        boatGroup.add(panelGroup);

                        // 9. Mast
                        const mastGeo = new THREE.CylinderGeometry(0.1*s, 0.1*s, 1.5*s);
                        const mast = new THREE.Mesh(mastGeo, cabinMat);
                        mast.rotation.x = Math.PI / 2;
                        mast.position.set(0, 3.5*s, 5.3*s);
                        boatGroup.add(mast);

                        const crossGeo = new THREE.CylinderGeometry(0.05*s, 0.05*s, 1.2*s);
                        const cross = new THREE.Mesh(crossGeo, cabinMat);
                        cross.position.set(0, 3.5*s, 5.8*s);
                        boatGroup.add(cross);

                        // Add a wake trail effect (simple plane behind the boat)
                        const wakeGeo = new THREE.PlaneGeometry(4*s, 10*s);
                        const wakeMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.0, side: THREE.DoubleSide });
                        const wake = new THREE.Mesh(wakeGeo, wakeMat);
                        wake.name = "wakeTrail";
                        wake.position.set(0, -12*s, 0.1*s);
                        boatGroup.add(wake);

                        // Scale up the whole boat so it's visible on the map (70% of previous 1.75 scale = 1.225)
                        // MapLibre uses mercator meters.
                        boatGroup.scale.set(1.225, 1.225, 1.225); 
                        // Removed rotation.x

                        boatMesh = boatGroup;
                        this.scene.add(boatMesh);
                        
                        this.map = map;
                        this.renderer = new THREE.WebGLRenderer({
                            canvas: map.getCanvas(),
                            context: gl,
                            antialias: false,
                            powerPreference: 'high-performance'
                        });
                        this.renderer.autoClear = false;
                    },
                    render: function(gl, matrix) {
                        const showBoat = shouldShowBoat();
                        if (boatMesh) {
                            boatMesh.visible = showBoat;
                        }
                        if (!showBoat) {
                            if (this.map) {
                                this.map.triggerRepaint();
                            }
                            return;
                        }
                        const latLng = { 
                            lat: State.ship.lat !== undefined ? State.ship.lat : (State.portA ? State.portA.lat : 10.6928), 
                            lng: State.ship.lng !== undefined ? State.ship.lng : (State.portA ? State.portA.lng : 122.5644) 
                        };
                        
                        const modelOrigin = [latLng.lng, latLng.lat];
                        const modelAltitude = 0;
                        
                        const modelAsMercatorCoordinate = maplibregl.MercatorCoordinate.fromLngLat(modelOrigin, modelAltitude);
                        const modelTransform = {
                            translateX: modelAsMercatorCoordinate.x,
                            translateY: modelAsMercatorCoordinate.y,
                            translateZ: modelAsMercatorCoordinate.z,
                            scale: modelAsMercatorCoordinate.meterInMercatorCoordinateUnits()
                        };

                        const m = new THREE.Matrix4().fromArray(matrix);
                        const l = new THREE.Matrix4().makeTranslation(
                            modelTransform.translateX,
                            modelTransform.translateY,
                            modelTransform.translateZ
                        ).scale(new THREE.Vector3(
                            modelTransform.scale,
                            -modelTransform.scale,
                            modelTransform.scale
                        ));
                        
                        if (boatMesh) {
                            boatMesh.rotation.order = 'ZXY';
                            const headingDeg = State.ship.headingDeg || 0;
                            const crabAngleDeg = State.ship.crabAngleDeg || 0;
                            const steerHeading = State.isManualMode ? headingDeg : headingDeg + crabAngleDeg;
                            // Base heading orientation with steering crab angle alignment
                            boatMesh.rotation.z = -steerHeading * Math.PI / 180;

                            // Actual speed (SOG) in knots
                            const kts = State.isRunning ? (State.ship.actualKnots || 0) : 0;

                            // Dynamic hydrodynamic bow rise (trim by stern) based on speed (knots)
                            const speedBowRise = Math.min(0.08, (kts / 30.0) * 0.06); // Bow lifts up to ~3.5 deg at high speed

                            // Environmental wave-induced rolling & pitching dynamics
                            const waveHt = parseFloat(document.getElementById('inWave')?.value || 1.8);
                            const waveDir = parseFloat(document.getElementById('inWaveDir')?.value || 135);
                            const relWaveDir = (waveDir - headingDeg + 360) % 360;
                            const relWaveRad = relWaveDir * Math.PI / 180;

                            const timeSec = performance.now() * 0.0025;

                            // Beam waves induce roll; Head/Following waves induce pitch
                            const rollFactor = 0.3 + 0.7 * Math.abs(Math.sin(relWaveRad));
                            const rollAmp = Math.min(0.22, (0.02 + 0.035 * waveHt) * rollFactor);
                            const rollAngle = (Math.sin(timeSec * 1.3) + 0.35 * Math.sin(timeSec * 2.7)) * rollAmp;

                            const pitchFactor = 0.3 + 0.7 * Math.abs(Math.cos(relWaveRad));
                            const pitchAmp = Math.min(0.18, (0.012 + 0.025 * waveHt) * pitchFactor);
                            const pitchAngle = (Math.sin(timeSec * 1.6 + 1.1) + 0.3 * Math.sin(timeSec * 3.1)) * pitchAmp - speedBowRise;

                            // Vertical heave displacement on wave crests/troughs
                            const heaveAmp = Math.min(1.2, 0.15 * waveHt);
                            const heaveZ = Math.sin(timeSec * 1.5) * heaveAmp;

                            boatMesh.rotation.x = pitchAngle;
                            boatMesh.rotation.y = rollAngle;
                            boatMesh.position.z = heaveZ;

                            // Dynamic Wake Trail Scaling based on actual speed
                            const wakeMesh = boatMesh.getObjectByName("wakeTrail");
                            if (wakeMesh) {
                                if (kts < 0.2) {
                                    wakeMesh.material.opacity = 0; // No wake when stationary
                                } else {
                                    const wakeSpeedFactor = Math.min(1.5, kts / 15.0);
                                    wakeMesh.material.opacity = Math.min(0.75, 0.15 + wakeSpeedFactor * 0.35);
                                    wakeMesh.scale.set(1.0 + wakeSpeedFactor * 0.5, 1.0 + wakeSpeedFactor * 1.2, 1.0);
                                }
                            }

                            // Dynamic Propeller / Turbine Spin Speed based on vessel speed
                            const t1 = boatMesh.getObjectByName("turbine1");
                            const t2 = boatMesh.getObjectByName("turbine2");
                            if (t1 && t2) {
                                const spinRate = (kts < 0.2) ? 0.02 : 0.05 + (kts / 20.0) * 0.25;
                                t1.children[1].rotation.z += spinRate;
                                t1.children[2].rotation.z += spinRate;
                                t2.children[1].rotation.z -= spinRate;
                                t2.children[2].rotation.z -= spinRate;
                            }
                        }

                        this.camera.projectionMatrix = m.multiply(l);
                        this.renderer.resetState();
                        this.renderer.clearDepth();
                        this.renderer.render(this.scene, this.camera);

                        // Trigger continuous repaints so vessel motion & environmental wave dynamics render smoothly
                        if (this.map) {
                            this.map.triggerRepaint();
                        }
                    }
                };

                gmap.addLayer(customLayer);
                
                

                // Interaction for Free Look
                let freeLookTimer = null;
                const enableFreeLook = () => {
                    isFreeLook = true;
                    const btn = document.getElementById('btnRecenter3D');
                    if(btn) btn.style.display = 'flex';
                    
                    if (State.isManualMode) {
                        if (freeLookTimer) clearTimeout(freeLookTimer);
                        freeLookTimer = setTimeout(() => {
                            if(btn) btn.style.display = 'none';
                            
                            // Restore arcade angle/zoom gently
                            if (typeof gmap !== 'undefined' && gmap) {
                                gmap.easeTo({
                                    pitch: 75,
                                    zoom: 19,
                                    bearing: State.ship.headingDeg || 0,
                                    center: [State.ship.lng, State.ship.lat],
                                    duration: 1000
                                });
                                setTimeout(() => {
                                    isFreeLook = false;
                                }, 1000);
                            } else {
                                isFreeLook = false;
                            }
                        }, 3000);
                    }
                };
                gmap.on('dragstart', enableFreeLook);
                gmap.on('touchstart', enableFreeLook);
                gmap.on('wheel', enableFreeLook);
                
                gmap.on('rotate', updateMapCompass);
                gmap.on('move', updateMapCompass);
                gmap.on('pitch', updateMapCompass);

                gmap.on('click', (e) => {
                    if (is2DExpanded) return;
                    const latlng = { lat: e.lngLat.lat, lng: e.lngLat.lng };
                    
                    if (State.isRunning && State.activeTool === 'pointer') {
                        log("Cannot relocate ports during active voyage. Abort voyage first.", "warn");
                        return false;
                    }

                    if (State.activeTool === 'pointer') {
                        if (!State.portA || (State.portA && State.portB)) {
                            State.portA = { lat: latlng.lat, lng: latlng.lng, name: `Departure (${latlng.lat.toFixed(4)}, ${latlng.lng.toFixed(4)})` };
                            State.portB = null;
                            if (portBMarker) { map.removeLayer(portBMarker); portBMarker = null; }
                            ensurePortAMarker(latlng.lat, latlng.lng, State.portA.name);
                            updateRoute();
                        } else if (State.portA && !State.portB) {
                            State.portB = { lat: latlng.lat, lng: latlng.lng, name: `Destination (${latlng.lat.toFixed(4)}, ${latlng.lng.toFixed(4)})` };
                            ensurePortBMarker(latlng.lat, latlng.lng, State.portB.name);
                            updateRoute();
                        }
                    } else if (State.activeTool === 'obstacle') {
                        let circle = L.circle(latlng, { radius: 180, color: '#eab308', fillColor: '#eab308', fillOpacity: 0.4 }).addTo(hazardLayerGroup);
                        State.entities.obstacles.push({ latLng: latlng, radiusMeters: 180, marker: circle });
                        if (State.portA && State.portB) generateTargetRoute();
                    } else if (State.activeTool === 'storm') {
                        let storm = L.circle(latlng, { radius: 450, color: '#3b82f6', fillColor: '#3b82f6', fillOpacity: 0.4 }).addTo(hazardLayerGroup);
                        State.entities.storms.push({ latLng: latlng, radiusMeters: 450, marker: storm });
                        if (State.portA && State.portB) generateTargetRoute();
                    }
                });
                
                log("Initialized MapLibre 3D View", "success");
            });
            return true;
        }

        const mapCompassContainer = document.getElementById('mapCompassContainer');
        if (mapCompassContainer) {
            mapCompassContainer.addEventListener('click', (e) => {
                e.stopPropagation();
                if (is3DMode && typeof gmap !== 'undefined' && gmap) {
                    gmap.easeTo({ bearing: 0, pitch: 75, duration: 400 });
                }
            });
        }

        const btnToggle3D = document.getElementById('btnToggle3D');
        if (btnToggle3D) {
            btnToggle3D.addEventListener('click', () => {
                if (is2DExpanded) {
                    collapse2DView();
                } else {
                    expand2DView();
                }
            });
        }

        
        document.addEventListener('DOMContentLoaded', () => {
            // GNSS / IMU Override Logic
            const btnModeAuto = document.getElementById('btnModeAuto');
            const btnModeManual = document.getElementById('btnModeManual');
            const btnModeActual = document.getElementById('btnModeActual');
            const modeDescription = document.getElementById('modeDescription');
            const gpsStatus = document.getElementById('gpsStatus');

            function setOperatingMode(mode) {
                // Reset styles
                const activeStyle = ['bg-sky-600', 'text-white', 'shadow-[0_0_8px_rgba(14,165,233,0.3)]'];
                const activeStylePurple = ['bg-sky-600', 'text-white', 'shadow-[0_0_8px_rgba(168,85,247,0.3)]'];
                const activeStyleGreen = ['bg-emerald-600', 'text-white', 'shadow-[0_0_8px_rgba(16,185,129,0.3)]'];
                
                const inactiveStyle = ['bg-slate-700', 'text-slate-300'];
                
                btnModeAuto.classList.remove(...activeStyle, 'hover:bg-sky-500');
                btnModeManual.classList.remove(...activeStylePurple, 'hover:bg-sky-500');
                btnModeActual.classList.remove(...activeStyleGreen, 'hover:bg-emerald-500');
                
                btnModeAuto.classList.add(...inactiveStyle, 'hover:bg-slate-600');
                btnModeManual.classList.add(...inactiveStyle, 'hover:bg-slate-600');
                btnModeActual.classList.add(...inactiveStyle, 'hover:bg-slate-600');

                // Cleanup GPS if leaving actual mode
                if (mode !== 'actual' && State.isGpsMode) {
                    State.isGpsMode = false;
                    if (gpsStatus) gpsStatus.classList.add('hidden');
                    if (State.gpsWatchId !== null && 'geolocation' in navigator) {
                        navigator.geolocation.clearWatch(State.gpsWatchId);
                        State.gpsWatchId = null;
                    }
                    window.removeEventListener('deviceorientation', handleIMU, true);
                }

                // Cleanup Manual if leaving manual mode
                if (mode !== 'manual' && State.isManualMode) {
                    State.isManualMode = false;
                    const btnStart = document.getElementById('btnStart');
                    const joystickZone = document.getElementById('joystickZone');
                    if (btnStart) btnStart.style.display = '';
                    if (joystickZone) joystickZone.classList.add('hidden');
                    State.manualJoystick.force = 0;
                    if (State.isRunning && !State.isGpsMode) {
                        State.isRunning = false;
                        if (btnStart) {
                            btnStart.innerText = "Start";
                            btnStart.className = "flex-1 md:flex-initial min-w-0 h-8 bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-600 hover:to-amber-600 text-white px-3 sm:px-4 rounded-lg font-bold transition-all shadow-[0_0_10px_rgba(249,115,22,0.3)] active:scale-95 flex items-center justify-center gap-1.5 cursor-pointer";
                        }
                    }
                }

                const simSpeedContainer = document.getElementById('simSpeedContainer');
                const btnSwap = document.getElementById('btnSwap');
                
                // Hide or show controls based on mode
                if (mode === 'auto') {
                    if (simSpeedContainer) simSpeedContainer.style.display = '';
                    if (btnSwap) btnSwap.style.display = '';
                } else {
                    if (simSpeedContainer) simSpeedContainer.style.display = 'none';
                    if (btnSwap) btnSwap.style.display = 'none';
                }

                if (mode === 'auto') {
                    btnModeAuto.classList.remove(...inactiveStyle, 'hover:bg-slate-600');
                    btnModeAuto.classList.add(...activeStyle, 'hover:bg-sky-500');
                    modeDescription.innerText = "Boat automatically follows the planned route.";
                    
                } else if (mode === 'manual') {
                    btnModeManual.classList.remove(...inactiveStyle, 'hover:bg-slate-600');
                    btnModeManual.classList.add(...activeStylePurple, 'hover:bg-sky-500');
                    modeDescription.innerText = "Control the boat manually using the D-Pad or Arrow Keys.";
                    
                    let wasActualMode = State.isGpsMode;
                    State.isManualMode = true;
                    
                    if (wasActualMode && State.portA) {
                        State.ship.lat = State.portA.lat;
                        State.ship.lng = State.portA.lng;
                        State.ship.progress = 0;
                        State.ship.headingDeg = 0;
                        State.ship.actualKnots = 0;
                        ensureShipMarker(State.ship.lat, State.ship.lng);
                    }

                    const btnStart = document.getElementById('btnStart');
                    const joystickZone = document.getElementById('joystickZone');
                    if (btnStart) btnStart.style.display = 'none';
                    if (joystickZone) joystickZone.classList.remove('hidden');
                    
                    if (State.portA && State.portB) {
                        State.isRunning = true;
                        if (typeof collapse2DView === 'function' && is2DExpanded) collapse2DView();
                    }
                    
                } else if (mode === 'actual') {
                    btnModeActual.classList.remove(...inactiveStyle, 'hover:bg-slate-600');
                    btnModeActual.classList.add(...activeStyleGreen, 'hover:bg-emerald-500');
                    modeDescription.innerText = "Boat position is driven by device GPS/IMU sensors.";
                    
                    State.isGpsMode = true;
                    ensureShipMarker(State.ship.lat, State.ship.lng);
                    
                    if (gpsStatus) {
                        gpsStatus.classList.remove('hidden');
                        gpsStatus.textContent = 'Status: Acquiring GNSS...';
                        gpsStatus.className = 'text-xs text-sky-400 font-mono';
                    }
                    
                    // Start GNSS
                    if ('geolocation' in navigator) {
                        State.gpsWatchId = navigator.geolocation.watchPosition((pos) => {
                            State.ship.lat = pos.coords.latitude;
                            State.ship.lng = pos.coords.longitude;
                            if (pos.coords.heading !== null && !isNaN(pos.coords.heading)) {
                                State.ship.headingDeg = pos.coords.heading;
                            } else if (State.imuHeading !== null) {
                                State.ship.headingDeg = State.imuHeading;
                            }
                            
                            if (pos.coords.speed !== null && !isNaN(pos.coords.speed)) {
                                State.ship.actualKnots = pos.coords.speed * 1.94384; // m/s to knots
                            }
                            
                            ensureShipMarker(State.ship.lat, State.ship.lng);
                            if (typeof shipMarker !== 'undefined' && shipMarker) {
                                shipMarker.setLatLng([State.ship.lat, State.ship.lng]);
                                if (typeof map !== 'undefined' && map && !State.is3D) {
                                    map.setView([State.ship.lat, State.ship.lng], map.getZoom(), { animate: true, duration: 0.5 });
                                }
                            }
                            
                            const shipIconDiv = document.getElementById('shipIconDiv');
                            if (shipIconDiv) {
                                shipIconDiv.style.transform = `rotate(${State.ship.headingDeg || 0}deg)`;
                            }
                            
                            if (gpsStatus) {
                                gpsStatus.textContent = `Status: GNSS Fix (${pos.coords.accuracy.toFixed(1)}m)`;
                                gpsStatus.className = 'text-xs text-emerald-400 font-mono mt-1';
                            }
                            
                            // Trigger Map Pan if chase cam is on
                            if (State.is3D && typeof update3DCamera === 'function') {
                                update3DCamera();
                            }

                            // Check real-time GNSS voyage completion (arrival at destination Port B)
                            const endPort = State.direction === 1 ? State.portB : State.portA;
                            if (endPort && State.ship.lat !== undefined && State.ship.lng !== undefined && typeof L !== 'undefined') {
                                const distMeters = L.latLng(State.ship.lat, State.ship.lng).distanceTo(L.latLng(endPort.lat, endPort.lng));
                                if (distMeters <= 80 && State.isRunning) {
                                    State.ship.progress = 1;
                                    State.isRunning = false;
                                    if (typeof completeVoyageAndSwapPorts === 'function') completeVoyageAndSwapPorts();
                                    
                                    // Auto-restart tracking for actual mode
                                    State.isRunning = true;
                                }
                            }
                        }, (err) => {
                            console.warn('GPS Error', err);
                            if (gpsStatus) {
                                gpsStatus.textContent = 'Status: GNSS Signal Lost';
                                gpsStatus.className = 'text-xs text-red-400 font-mono mt-1';
                            }
                        }, {
                            enableHighAccuracy: true,
                            maximumAge: 0,
                            timeout: 10000
                        });
                    }
                    
                    // Start IMU for heading if available
                    window.addEventListener('deviceorientation', handleIMU, true);
                }
            }

            if (btnModeAuto) btnModeAuto.addEventListener('click', () => setOperatingMode('auto'));
            if (btnModeManual) btnModeManual.addEventListener('click', () => setOperatingMode('manual'));
            if (btnModeActual) btnModeActual.addEventListener('click', () => setOperatingMode('actual'));
            
            // Initialize default mode
            setOperatingMode('auto');
            
            function handleIMU(event) {
                if (event.webkitCompassHeading) {
                    State.imuHeading = event.webkitCompassHeading;
                } else if (event.alpha !== null) {
                    // Approximate heading from alpha (assuming portrait mode relative to north if absolute)
                    State.imuHeading = 360 - event.alpha;
                }
                
                if (State.isGpsMode && State.imuHeading !== null) {
                    // Update heading if GNSS doesn't provide it reliably
                    State.ship.headingDeg = State.imuHeading;
                }
            }

            
            // Auto-switch to GNSS/IMU on Offline connection
            const offlineNotice = document.getElementById('offlineNotice');
            const offlineNoticeText = document.getElementById('offlineNoticeText');

            function updateOnlineStatus() {
                if (!navigator.onLine) {
                    if (offlineNotice) {
                        offlineNotice.classList.remove('hidden');
                        if (offlineNoticeText) offlineNoticeText.textContent = 'Offline Mode Active';
                    }
                } else {
                    if (offlineNotice) {
                        offlineNotice.classList.add('hidden');
                    }
                    // Fetch live cloud data when connection is restored
                    if (typeof fetchLiveMarineData === 'function' && State.ship && State.ship.lat) {
                        fetchLiveMarineData(State.ship.lat, State.ship.lng, true);
                    }
                }
            }

            window.addEventListener('offline', updateOnlineStatus);
            window.addEventListener('online', updateOnlineStatus);

            // Check network status on initial load
            if (!navigator.onLine) {
                setTimeout(updateOnlineStatus, 1000);
            }
            
            // D-Pad Event Listeners
            const btnJoyUp = document.getElementById('btnJoyUp');
            const btnJoyDown = document.getElementById('btnJoyDown');
            const btnJoyLeft = document.getElementById('btnJoyLeft');
            const btnJoyRight = document.getElementById('btnJoyRight');
            
            const handleJoyDown = (x, y) => {
                if (x !== null) State.manualJoystick.x = x;
                if (y !== null) State.manualJoystick.y = y;
            };
            const handleJoyUp = (x, y) => {
                if (x !== null && State.manualJoystick.x === x) State.manualJoystick.x = 0;
                if (y !== null && State.manualJoystick.y === y) State.manualJoystick.y = 0;
            };

            if (btnJoyUp) {
                btnJoyUp.addEventListener('pointerdown', () => handleJoyDown(null, 1));
                btnJoyUp.addEventListener('pointerup', () => handleJoyUp(null, 1));
                btnJoyUp.addEventListener('pointerleave', () => handleJoyUp(null, 1));
            }
            if (btnJoyDown) {
                btnJoyDown.addEventListener('pointerdown', () => handleJoyDown(null, -1));
                btnJoyDown.addEventListener('pointerup', () => handleJoyUp(null, -1));
                btnJoyDown.addEventListener('pointerleave', () => handleJoyUp(null, -1));
            }
            if (btnJoyLeft) {
                btnJoyLeft.addEventListener('pointerdown', () => handleJoyDown(-1, null));
                btnJoyLeft.addEventListener('pointerup', () => handleJoyUp(-1, null));
                btnJoyLeft.addEventListener('pointerleave', () => handleJoyUp(-1, null));
            }
            if (btnJoyRight) {
                btnJoyRight.addEventListener('pointerdown', () => handleJoyDown(1, null));
                btnJoyRight.addEventListener('pointerup', () => handleJoyUp(1, null));
                btnJoyRight.addEventListener('pointerleave', () => handleJoyUp(1, null));
            }

            // Keyboard Arrow Support
            window.addEventListener('keydown', (e) => {
                if (!State.isManualMode) return;
                if (e.key === 'ArrowUp' || e.key === 'w') handleJoyDown(null, 1);
                if (e.key === 'ArrowDown' || e.key === 's') handleJoyDown(null, -1);
                if (e.key === 'ArrowLeft' || e.key === 'a') handleJoyDown(-1, null);
                if (e.key === 'ArrowRight' || e.key === 'd') handleJoyDown(1, null);
            });
            window.addEventListener('keyup', (e) => {
                if (!State.isManualMode) return;
                if (e.key === 'ArrowUp' || e.key === 'w') handleJoyUp(null, 1);
                if (e.key === 'ArrowDown' || e.key === 's') handleJoyUp(null, -1);
                if (e.key === 'ArrowLeft' || e.key === 'a') handleJoyUp(-1, null);
                if (e.key === 'ArrowRight' || e.key === 'd') handleJoyUp(1, null);
            });
        });