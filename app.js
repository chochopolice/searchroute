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
const STREETVIEW_RADIUS = 50;       // ストリートビュー検索半径（メートル）
const LOOKAHEAD_POINTS = 2;         // 進行方向を決めるための先読みポイント数
const INTERVAL_MS = 3000;           // ストリートビュー移動間隔（ミリ秒）
const ROUTE_SAMPLE_RATE = 5;        // 経路座標の間引き率（1/N点を使用）

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
        {
            position: begin,
            pov: { heading: 0, pitch: 0 },
            zoom: 1,
        }
    );

    directionsService = new google.maps.DirectionsService();
    directionsRenderer = new google.maps.DirectionsRenderer();
    directionsRenderer.setMap(map);
    geocoder = new google.maps.Geocoder();
    map.setStreetView(panorama);

    // マップクリックでマーカーを移動
    map.addListener("click", (event) => {
        createMarker(event.latLng);
    });

    // 検索オートコンプリート設定
    const locationInput = document.getElementById("location-input");
    const autocomplete = new google.maps.places.Autocomplete(locationInput);

    document.getElementById("search-location").addEventListener("click", () => {
        const place = autocomplete.getPlace();
        if (!place || !place.geometry) {
            alert("有効な地点を選択してください。");
            return;
        }
        const position = place.geometry.location;
        map.setCenter(position);
        map.setZoom(16);
        createMarker(position);
    });

    // 起点設定
    document.getElementById("set-start").addEventListener("click", () => {
        if (!assertMarkerExists()) return;
        startLocation = marker.getPosition();
        alert("起点が設定されました。");
        updateRouteInfo();
        updateButtonStates();
    });

    // 終点設定
    document.getElementById("set-end").addEventListener("click", () => {
        if (!assertMarkerExists()) return;
        endLocation = marker.getPosition();
        alert("終点が設定されました。");
        updateRouteInfo();
        updateButtonStates();
    });

    // 経由地追加
    document.getElementById("add-waypoint").addEventListener("click", () => {
        if (!assertMarkerExists()) return;
        waypoints.push({ location: marker.getPosition(), stopover: true });
        refreshWaypointMarkers();
        updateRouteInfo();
        if (startLocation && endLocation) calculateRoute();
    });

    // 経由地クリア
    document.getElementById("clear-waypoints").addEventListener("click", () => {
        waypoints = [];
        refreshWaypointMarkers();
        updateRouteInfo();
        if (startLocation && endLocation) calculateRoute();
    });

    // 経路検索
    document.getElementById("search-route").addEventListener("click", () => {
        if (!startLocation || !endLocation) {
            alert("起点と終点を設定してください。");
            return;
        }
        calculateRoute();
    });

    // 起点・終点 入れ替え
    document.getElementById("swap-locations").addEventListener("click", () => {
        if (!startLocation || !endLocation) {
            alert("起点または終点が設定されていません。");
            return;
        }
        [startLocation, endLocation] = [endLocation, startLocation];
        waypoints.reverse();
        refreshWaypointMarkers();
        updateRouteInfo();
        calculateRoute();
    });

    // ストリートビュー 開始
    document.getElementById("start-streetview").addEventListener("click", () => {
        if (route.length === 0) {
            alert("有効な経路がありません。");
            return;
        }
        startStreetView();
    });

    // ストリートビュー 停止
    document.getElementById("stop-streetview").addEventListener("click", () => {
        stopStreetView();
    });

    // ストリートビュー 再開
    document.getElementById("resume-streetview").addEventListener("click", () => {
        resumeStreetView();
    });

    // 初期表示
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
        const m = new google.maps.Marker({
            position: w.location,
            map,
            label: `${i + 1}`,
        });
        waypointMarkers.push(m);
    });
}

// =============================================
//  ボタンの有効・無効管理
// =============================================
function updateButtonStates() {
    const hasRoute = startLocation && endLocation;
    document.getElementById("search-route").disabled = !hasRoute;
    document.getElementById("swap-locations").disabled = !hasRoute;
    document.getElementById("start-streetview").disabled = route.length === 0;
}

// =============================================
//  住所逆引き（緯度経度 → 住所文字列）
// =============================================
function reverseGeocodeLatLng(latLng) {
    return new Promise((resolve) => {
        if (!geocoder) return resolve(null);
        geocoder.geocode({ location: latLng }, (results, status) => {
            if (status !== "OK" || !results || results.length === 0) return resolve(null);
            resolve(results[0].formatted_address);
        });
    });
}

// =============================================
//  ルート情報パネルの更新
// =============================================
async function updateRouteInfo() {
    const startEl = document.getElementById("start-view");
    const endEl = document.getElementById("end-view");

    if (startEl) startEl.textContent = startLocation ? "取得中…" : "未設定";
    if (endEl) endEl.textContent = endLocation ? "取得中…" : "未設定";

    if (startLocation && startEl) {
        const addr = await reverseGeocodeLatLng(startLocation);
        startEl.textContent = addr || `${startLocation.lat().toFixed(6)}, ${startLocation.lng().toFixed(6)}`;
    }
    if (endLocation && endEl) {
        const addr = await reverseGeocodeLatLng(endLocation);
        endEl.textContent = addr || `${endLocation.lat().toFixed(6)}, ${endLocation.lng().toFixed(6)}`;
    }

    const listEl = document.getElementById("waypoints-view");
    const emptyEl = document.getElementById("waypoints-empty");
    if (!listEl) return;

    listEl.innerHTML = "";
    const hasWp = waypoints.length > 0;
    if (emptyEl) emptyEl.style.display = hasWp ? "none" : "block";
    if (!hasWp) return;

    for (let i = 0; i < waypoints.length; i++) {
        const w = waypoints[i];
        const addr = await reverseGeocodeLatLng(w.location);
        const label = addr || `${w.location.lat().toFixed(6)}, ${w.location.lng().toFixed(6)}`;

        const li = document.createElement("li");
        li.style.cssText = "display:flex; align-items:center; gap:8px; margin-bottom:6px;";

        const text = document.createElement("div");
        text.style.flex = "1";
        text.innerHTML = `<strong>${i + 1}.</strong> ${label}`;

        const btnUp = createWaypointButton("↑", i === 0, () => moveWaypoint(i, i - 1));
        const btnDown = createWaypointButton("↓", i === waypoints.length - 1, () => moveWaypoint(i, i + 1));
        const btnDel = createWaypointButton("×", false, () => deleteWaypoint(i));

        li.append(text, btnUp, btnDown, btnDel);
        listEl.appendChild(li);
    }
}

function createWaypointButton(label, disabled, onClick) {
    const btn = document.createElement("button");
    btn.textContent = label;
    btn.disabled = disabled;
    btn.addEventListener("click", onClick);
    return btn;
}

// =============================================
//  経由地の操作
// =============================================
function deleteWaypoint(index) {
    if (index < 0 || index >= waypoints.length) return;
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
//  経路検索
// =============================================
function calculateRoute() {
    directionsService.route(
        {
            origin: startLocation,
            destination: endLocation,
            waypoints: waypoints,
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
            step.path.forEach((pathPoint, index) => {
                if (index % ROUTE_SAMPLE_RATE === 0) {
                    points.push(pathPoint);
                }
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
    if (moveInterval) {
        clearInterval(moveInterval);
        moveInterval = null;
    }
    isStreetViewRunning = false;
}

function resumeStreetView() {
    if (isStreetViewRunning) return;
    isStreetViewRunning = true;
    runStreetViewLoop();
}

function runStreetViewLoop() {
    if (moveInterval) {
        clearInterval(moveInterval);
        moveInterval = null;
    }

    moveInterval = setInterval(() => {
        if (!isStreetViewRunning) {
            stopStreetView();
            return;
        }
        if (currentIndex >= route.length) {
            stopStreetView();
            alert("到着しました！");
            return;
        }

        const position = route[currentIndex];
        panorama.setPosition(position);
        map.setCenter(position);

        const lookAheadIndex = Math.min(currentIndex + LOOKAHEAD_POINTS, route.length - 1);
        const nextPos = route[lookAheadIndex];
        if (nextPos) setPovTowardNextPoint(position, nextPos);

        currentIndex++;
    }, INTERVAL_MS);
}

function setPovTowardNextPoint(currentPos, nextPos) {
    if (!currentPos || !nextPos) return;
    if (!google.maps.geometry || !google.maps.geometry.spherical) return;

    const heading = google.maps.geometry.spherical.computeHeading(currentPos, nextPos);
    const pov = panorama.getPov() || { heading: 0, pitch: 0 };
    panorama.setPov({ heading, pitch: pov.pitch ?? 0 });
}

// =============================================
//  エントリーポイント
// =============================================
window.onload = initMap;
