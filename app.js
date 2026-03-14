// =============================================
//  Google Maps ストリートビュー 散歩アプリ
// =============================================

// --- グローバル変数 ---
let geocoder;
let map, panorama;
let marker = null;
let startLocation = null;
let endLocation = null;
let waypoints = [];
let waypointMarkers = [];
let directionsService, directionsRenderer;
let moveInterval = null;
let currentIndex = 0;
let route = [];
let isStreetViewRunning = false;

// --- 設定値 ---
const LOOKAHEAD_POINTS  = 2;      // 進行方向の先読みポイント数
const INTERVAL_MS       = 3000;   // ストリートビュー移動間隔（ミリ秒）
const ROUTE_SAMPLE_RATE = 5;      // 経路座標の間引き率

// ランダムルート設定
const RANDOM_ROUTE_MIN_KM    = 5;      // 最短距離（緩めに）
const RANDOM_ROUTE_MAX_KM    = 50;     // 最長距離（緩めに）
const RANDOM_ROUTE_MAX_TRIES = 60;     // 最大試行回数
const RANDOM_END_RADIUS_M    = 20000;  // 終点候補の探索半径
const RANDOM_SV_RADIUS_M     = 2000;   // Street View スナップ半径（広めに）

// =============================================
//  初期化
// =============================================
function initMap() {
    const begin = { lat: 35.681236, lng: 139.767125 }; // 東京駅

    map = new google.maps.Map(document.getElementById("map"), {
        center: begin,
        zoom: 16,
    });

    panorama = new google.maps.StreetViewPanorama(
        document.getElementById("street-view"),
        { position: begin, pov: { heading: 0, pitch: 0 }, zoom: 1 }
    );

    directionsService  = new google.maps.DirectionsService();
    directionsRenderer = new google.maps.DirectionsRenderer();
    directionsRenderer.setMap(map);
    geocoder = new google.maps.Geocoder();
    map.setStreetView(panorama);

    // マップクリックでマーカーを移動
    map.addListener("click", (event) => createMarker(event.latLng));

    // 検索オートコンプリート
    const autocomplete = new google.maps.places.Autocomplete(
        document.getElementById("location-input")
    );
    document.getElementById("search-location").addEventListener("click", () => {
        const place = autocomplete.getPlace();
        if (!place || !place.geometry) { alert("有効な地点を選択してください。"); return; }
        const pos = place.geometry.location;
        map.setCenter(pos);
        map.setZoom(16);
        createMarker(pos);
    });

    document.getElementById("set-start").addEventListener("click", () => {
        if (!assertMarkerExists()) return;
        startLocation = marker.getPosition();
        alert("起点が設定されました。");
        updateRouteInfo();
        updateButtonStates();
    });

    document.getElementById("set-end").addEventListener("click", () => {
        if (!assertMarkerExists()) return;
        endLocation = marker.getPosition();
        alert("終点が設定されました。");
        updateRouteInfo();
        updateButtonStates();
    });

    document.getElementById("add-waypoint").addEventListener("click", () => {
        if (!assertMarkerExists()) return;
        waypoints.push({ location: marker.getPosition(), stopover: true });
        refreshWaypointMarkers();
        updateRouteInfo();
        if (startLocation && endLocation) calculateRoute();
    });

    document.getElementById("clear-waypoints").addEventListener("click", () => {
        waypoints = [];
        refreshWaypointMarkers();
        updateRouteInfo();
        if (startLocation && endLocation) calculateRoute();
    });

    document.getElementById("search-route").addEventListener("click", () => {
        if (!startLocation || !endLocation) { alert("起点と終点を設定してください。"); return; }
        calculateRoute();
    });

    document.getElementById("swap-locations").addEventListener("click", () => {
        if (!startLocation || !endLocation) { alert("起点または終点が設定されていません。"); return; }
        [startLocation, endLocation] = [endLocation, startLocation];
        waypoints.reverse();
        refreshWaypointMarkers();
        updateRouteInfo();
        calculateRoute();
    });

    document.getElementById("start-streetview").addEventListener("click", () => {
        if (route.length === 0) { alert("有効な経路がありません。"); return; }
        startStreetView();
    });

    document.getElementById("stop-streetview").addEventListener("click",   () => stopStreetView());
    document.getElementById("resume-streetview").addEventListener("click", () => resumeStreetView());

    document.getElementById("random-world-route").addEventListener("click", async () => {
        await generateRandomWorldRoute();
    });

    updateRouteInfo();
    updateButtonStates();
}

// =============================================
//  マーカー
// =============================================
function createMarker(position) {
    if (marker) marker.setMap(null);
    marker = new google.maps.Marker({ position, map });
}

function assertMarkerExists() {
    if (marker && marker.getPosition()) return true;
    alert("地点を検索またはマップ上で指定してください。");
    return false;
}

// =============================================
//  経由地マーカー
// =============================================
function refreshWaypointMarkers() {
    waypointMarkers.forEach((m) => m.setMap(null));
    waypointMarkers = [];
    waypoints.forEach((w, i) => {
        waypointMarkers.push(new google.maps.Marker({
            position: w.location, map, label: `${i + 1}`
        }));
    });
}

// =============================================
//  ボタン状態管理
// =============================================
function updateButtonStates() {
    const hasEnds = !!(startLocation && endLocation);
    document.getElementById("search-route").disabled    = !hasEnds;
    document.getElementById("swap-locations").disabled  = !hasEnds;
    document.getElementById("start-streetview").disabled = route.length === 0;
}

// =============================================
//  住所逆引き
// =============================================
function reverseGeocodeLatLng(latLng) {
    return new Promise((resolve) => {
        if (!geocoder) return resolve(null);
        geocoder.geocode({ location: latLng }, (results, status) => {
            resolve(status === "OK" && results.length > 0 ? results[0].formatted_address : null);
        });
    });
}

// =============================================
//  ルート情報パネル更新
// =============================================
async function updateRouteInfo() {
    const startEl = document.getElementById("start-view");
    const endEl   = document.getElementById("end-view");

    if (startEl) startEl.textContent = startLocation ? "取得中…" : "未設定";
    if (endEl)   endEl.textContent   = endLocation   ? "取得中…" : "未設定";

    if (startLocation && startEl) {
        const addr = await reverseGeocodeLatLng(startLocation);
        startEl.textContent = addr || `${startLocation.lat().toFixed(6)}, ${startLocation.lng().toFixed(6)}`;
    }
    if (endLocation && endEl) {
        const addr = await reverseGeocodeLatLng(endLocation);
        endEl.textContent = addr || `${endLocation.lat().toFixed(6)}, ${endLocation.lng().toFixed(6)}`;
    }

    const listEl  = document.getElementById("waypoints-view");
    const emptyEl = document.getElementById("waypoints-empty");
    if (!listEl) return;

    listEl.innerHTML = "";
    const hasWp = waypoints.length > 0;
    if (emptyEl) emptyEl.style.display = hasWp ? "none" : "block";
    if (!hasWp) return;

    for (let i = 0; i < waypoints.length; i++) {
        const addr  = await reverseGeocodeLatLng(waypoints[i].location);
        const label = addr || `${waypoints[i].location.lat().toFixed(6)}, ${waypoints[i].location.lng().toFixed(6)}`;

        const li   = document.createElement("li");
        li.style.cssText = "display:flex; align-items:center; gap:8px; margin-bottom:6px;";

        const text = document.createElement("div");
        text.style.flex = "1";
        text.innerHTML  = `<strong>${i + 1}.</strong> ${label}`;

        li.append(
            text,
            createWaypointButton("↑", i === 0,                    () => moveWaypoint(i, i - 1)),
            createWaypointButton("↓", i === waypoints.length - 1, () => moveWaypoint(i, i + 1)),
            createWaypointButton("×", false,                       () => deleteWaypoint(i))
        );
        listEl.appendChild(li);
    }
}

function createWaypointButton(label, disabled, onClick) {
    const btn = document.createElement("button");
    btn.textContent = label;
    btn.disabled    = disabled;
    btn.addEventListener("click", onClick);
    return btn;
}

// =============================================
//  経由地操作
// =============================================
function deleteWaypoint(index) {
    waypoints.splice(index, 1);
    refreshWaypointMarkers();
    updateRouteInfo();
    if (startLocation && endLocation) calculateRoute();
}

function moveWaypoint(from, to) {
    if (to < 0 || to >= waypoints.length) return;
    const [item] = waypoints.splice(from, 1);
    waypoints.splice(to, 0, item);
    refreshWaypointMarkers();
    updateRouteInfo();
    if (startLocation && endLocation) calculateRoute();
}

// =============================================
//  Street View パノラマ取得
// =============================================
function getPanoramaAtPosition(latLng, radius) {
    return new Promise((resolve) => {
        const sv = new google.maps.StreetViewService();
        sv.getPanorama(
            { location: latLng, radius, source: google.maps.StreetViewSource.OUTDOOR },
            (data, status) => resolve(status === google.maps.StreetViewStatus.OK ? data : null)
        );
    });
}

// =============================================
//  世界ランダム経路
// =============================================

/**
 * Street Viewカバレッジが比較的高い地域の緯度経度範囲。
 * 完全ランダムより大幅に成功率が上がる。
 */
const SV_REGIONS = [
    { latMin:  24, latMax:  46, lngMin: 123, lngMax: 146 }, // 日本
    { latMin:  25, latMax:  50, lngMin: -125, lngMax: -65 }, // 北米
    { latMin:  35, latMax:  71, lngMin:  -10, lngMax:  40 }, // ヨーロッパ
    { latMin: -35, latMax:  -5, lngMin:  115, lngMax: 154 }, // オーストラリア
    { latMin: -35, latMax:   5, lngMin:  -75, lngMax: -34 }, // 南米
    { latMin:  -5, latMax:  37, lngMin:  -18, lngMax:  52 }, // アフリカ
    { latMin:  -5, latMax:  55, lngMin:   60, lngMax: 120 }, // アジア
];

function getRandomWorldPoint() {
    const region = SV_REGIONS[Math.floor(Math.random() * SV_REGIONS.length)];
    const lat = region.latMin + Math.random() * (region.latMax - region.latMin);
    const lng = region.lngMin + Math.random() * (region.lngMax - region.lngMin);
    return new google.maps.LatLng(lat, lng);
}

function getRandomNearbyPoint(center, maxRadiusMeters) {
    const heading  = Math.random() * 360;
    const distance = (0.3 + Math.random() * 0.7) * maxRadiusMeters; // 近すぎる終点を避ける
    return google.maps.geometry.spherical.computeOffset(center, distance, heading);
}

function getRouteDistanceMeters(response) {
    return response.routes[0].legs.reduce((sum, leg) => sum + leg.distance.value, 0);
}

async function generateRandomWorldRoute() {
    const minMeters = RANDOM_ROUTE_MIN_KM * 1000;
    const maxMeters = RANDOM_ROUTE_MAX_KM * 1000;

    const btn = document.getElementById("random-world-route");
    if (btn) { btn.disabled = true; btn.textContent = "検索中…"; }

    try {
        for (let i = 0; i < RANDOM_ROUTE_MAX_TRIES; i++) {

            // 1) Street Viewカバレッジが高い地域からランダム起点
            const randomStart = getRandomWorldPoint();

            // 2) 起点のStreet Viewスナップ（広めの半径で）
            const startPano = await getPanoramaAtPosition(randomStart, RANDOM_SV_RADIUS_M);
            if (!startPano?.location?.latLng) continue;
            const snappedStart = startPano.location.latLng;

            // 3) 終点候補（近すぎず遠すぎない距離でランダム）
            const randomEnd = getRandomNearbyPoint(snappedStart, RANDOM_END_RADIUS_M);

            // 4) 終点のStreet Viewスナップ
            const endPano = await getPanoramaAtPosition(randomEnd, RANDOM_SV_RADIUS_M);
            if (!endPano?.location?.latLng) continue;
            const snappedEnd = endPano.location.latLng;

            // 5) ルート検索（DRIVING → 失敗時は WALKING も試みる）
            let response = await requestRoute(snappedStart, snappedEnd, google.maps.TravelMode.DRIVING);
            if (!response) {
                response = await requestRoute(snappedStart, snappedEnd, google.maps.TravelMode.WALKING);
            }
            if (!response) continue;

            // 6) 距離チェック
            const totalDistance = getRouteDistanceMeters(response);
            if (totalDistance < minMeters || totalDistance > maxMeters) continue;

            // 7) 採用
            stopStreetView();
            startLocation = snappedStart;
            endLocation   = snappedEnd;
            waypoints     = [];
            refreshWaypointMarkers();

            directionsRenderer.setDirections(response);
            route = extractRouteCoordinates(response);

            map.setCenter(snappedStart);
            map.setZoom(13);
            createMarker(snappedStart);

            updateRouteInfo();
            updateButtonStates();

            const km = (totalDistance / 1000).toFixed(1);
            alert(`世界ランダムルートを設定しました！\n距離: ${km} km\n（試行 ${i + 1} 回目）`);
            return;
        }

        alert("条件に合うルートが見つかりませんでした。\nもう一度お試しください。");

    } finally {
        if (btn) { btn.disabled = false; btn.textContent = "世界ランダム"; }
    }
}

/** Directions API をPromiseでラップ */
function requestRoute(origin, destination, travelMode) {
    return new Promise((resolve) => {
        directionsService.route(
            { origin, destination, travelMode },
            (result, status) => resolve(status === google.maps.DirectionsStatus.OK ? result : null)
        );
    });
}

// =============================================
//  経路検索
// =============================================
function calculateRoute() {
    directionsService.route(
        {
            origin: startLocation,
            destination: endLocation,
            waypoints,
            optimizeWaypoints: false,
            travelMode: google.maps.TravelMode.DRIVING,
        },
        (response, status) => {
            if (status === google.maps.DirectionsStatus.OK) {
                directionsRenderer.setDirections(response);
                route = extractRouteCoordinates(response);
                updateButtonStates();
            } else {
                alert("経路情報を取得できませんでした: " + status);
            }
        }
    );
}

function extractRouteCoordinates(response) {
    const points = [];
    response.routes[0].legs.forEach((leg) => {
        leg.steps.forEach((step) => {
            step.path.forEach((pt, idx) => {
                if (idx % ROUTE_SAMPLE_RATE === 0) points.push(pt);
            });
        });
    });
    return points;
}

// =============================================
//  ストリートビュー制御
// =============================================
function startStreetView() {
    stopStreetView();
    currentIndex = 0;
    isStreetViewRunning = true;
    runStreetViewLoop();
}

function stopStreetView() {
    if (moveInterval) { clearInterval(moveInterval); moveInterval = null; }
    isStreetViewRunning = false;
}

function resumeStreetView() {
    if (isStreetViewRunning) return;
    isStreetViewRunning = true;
    runStreetViewLoop();
}

function runStreetViewLoop() {
    if (moveInterval) { clearInterval(moveInterval); moveInterval = null; }

    moveInterval = setInterval(() => {
        if (!isStreetViewRunning) { stopStreetView(); return; }
        if (currentIndex >= route.length) { stopStreetView(); alert("到着しました！"); return; }

        const position = route[currentIndex];
        panorama.setPosition(position);
        map.setCenter(position);

        const nextIdx = Math.min(currentIndex + LOOKAHEAD_POINTS, route.length - 1);
        if (route[nextIdx]) setPovTowardNextPoint(position, route[nextIdx]);

        currentIndex++;
    }, INTERVAL_MS);
}

function setPovTowardNextPoint(currentPos, nextPos) {
    if (!currentPos || !nextPos) return;
    if (!google.maps.geometry?.spherical) return;
    const heading = google.maps.geometry.spherical.computeHeading(currentPos, nextPos);
    const pov     = panorama.getPov() || { heading: 0, pitch: 0 };
    panorama.setPov({ heading, pitch: pov.pitch ?? 0 });
}

// =============================================
//  エントリーポイント
// =============================================
window.onload = initMap;
