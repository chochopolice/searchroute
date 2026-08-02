// =============================================
//  Google Maps ストリートビュー 散歩アプリ
//  v3: 動画風プレイヤー(Static API静止画シーケンス方式)
// =============================================

// --- グローバル変数 ---
let geocoder;
let map, panorama;              // panorama は「表示中(アクティブ)」のパノラマを指す
let marker = null;
let startLocation = null;
let endLocation = null;
let waypoints = [];
let waypointMarkers = [];
let directionsService, directionsRenderer;
let route = [];

// --- 設定値 ---
const LOOKAHEAD_POINTS  = 2;      // 何ポイント先を向くか
const BASE_INTERVAL_MS  = 2000;   // 等速(1x)時のフレーム間隔
const ROUTE_SAMPLE_RATE = 5;      // 経路ポイントの間引き率

const PANO_PREP_MAX         = 400; // これ以下のポイント数ならパノラマ事前解決を行う
const PANO_PREP_CONCURRENCY = 6;   // パノラマ解決の同時リクエスト数

// --- Static API 静止画シーケンス設定 ---
const STATIC_SIZE         = "640x400"; // 取得画像サイズ(Static APIの上限は640x640)
const STATIC_FOV          = 90;        // 視野角(小さいほどズーム)
const HEADING_STEP        = 5;         // PAN操作の角度刻み(画像キャッシュ単位)
const PREFETCH_AHEAD      = 8;         // 視点変更後に先読みするコマ数
const IMG_CONCURRENCY     = 6;         // 画像の同時読み込み数
const POV_REFRESH_MS      = 140;       // ドラッグ中の画像更新間隔
const PRELOAD_CONFIRM_OVER = 300;      // このコマ数を超える全読込は確認ダイアログを出す

const RANDOM_ROUTE_MIN_KM    = 5;
const RANDOM_ROUTE_MAX_KM    = 50;
const RANDOM_ROUTE_MAX_TRIES = 60;
const RANDOM_END_RADIUS_M    = 20000;
const RANDOM_SV_RADIUS_M     = 2000;

// =============================================
//  初期化
// =============================================
function initMap() {
    const begin = { lat: 35.681236, lng: 139.767125 };

    map = new google.maps.Map(document.getElementById("map"), {
        center: begin,
        zoom: 16,
    });


    directionsService  = new google.maps.DirectionsService();
    directionsRenderer = new google.maps.DirectionsRenderer();
    directionsRenderer.setMap(map);
    geocoder = new google.maps.Geocoder();
    map.setStreetView(panorama);

    map.addListener("click", (event) => createMarker(event.latLng));

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
        SvPlayer.start();
    });

    // 既存の停止/再開ボタンはプレイヤーの一時停止/再生に接続
    document.getElementById("stop-streetview").addEventListener("click",   () => SvPlayer.pause());
    document.getElementById("resume-streetview").addEventListener("click", () => SvPlayer.play());

    document.getElementById("random-world-route").addEventListener("click", async () => {
        await generateRandomWorldRoute();
    });

    // =============================================
    //  ★ 現在地取得
    // =============================================
    const locationButton = document.getElementById('locationButton');

    function getCurrentLocation() {
        if (!navigator.geolocation) {
            alert('このブラウザでは位置情報が使えません。');
            return;
        }
        locationButton.disabled = true;
        locationButton.textContent = '取得中...';

        navigator.geolocation.getCurrentPosition(
            pos => {
                const latLng = new google.maps.LatLng(pos.coords.latitude, pos.coords.longitude);
                map.setCenter(latLng);
                map.setZoom(16);
                createMarker(latLng);
                locationButton.disabled = false;
                locationButton.textContent = '現在地取得';
            },
            () => {
                alert('位置情報の取得に失敗しました。ブラウザの許可設定を確認してください。');
                locationButton.disabled = false;
                locationButton.textContent = '現在地取得';
            },
            { enableHighAccuracy: true, timeout: 8000 }
        );
    }

    locationButton.addEventListener('click', getCurrentLocation);

    // ★ プレイヤーUI(シークバー等)を注入して初期化
    SvPlayer.init();

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
    document.getElementById("search-route").disabled     = !hasEnds;
    document.getElementById("swap-locations").disabled   = !hasEnds;
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

    // 経由地リストを #waypoints-list に縦並びで描画
    const listEl = document.getElementById("waypoints-list");
    if (!listEl) return;
    listEl.innerHTML = "";

    for (let i = 0; i < waypoints.length; i++) {
        const addr  = await reverseGeocodeLatLng(waypoints[i].location);
        const label = addr || `${waypoints[i].location.lat().toFixed(6)}, ${waypoints[i].location.lng().toFixed(6)}`;

        const item = document.createElement("div");
        item.className = "waypoint-item";

        const wpLabel = document.createElement("span");
        wpLabel.className = "wp-label";
        wpLabel.innerHTML = `<span class="dot"></span>経由地${i + 1}`;

        const wpValue = document.createElement("span");
        wpValue.className = "wp-value";
        wpValue.textContent = label;

        const btns = document.createElement("div");
        btns.className = "wp-btns";
        btns.append(
            createWaypointButton("↑", i === 0,                    () => moveWaypoint(i, i - 1)),
            createWaypointButton("↓", i === waypoints.length - 1, () => moveWaypoint(i, i + 1)),
            createWaypointButton("×", false,                       () => deleteWaypoint(i))
        );

        item.append(wpLabel, wpValue, btns);
        listEl.appendChild(item);
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
const SV_REGIONS = [
    { latMin:  24, latMax:  46, lngMin: 123, lngMax: 146 },
    { latMin:  25, latMax:  50, lngMin: -125, lngMax: -65 },
    { latMin:  35, latMax:  71, lngMin:  -10, lngMax:  40 },
    { latMin: -35, latMax:  -5, lngMin:  115, lngMax: 154 },
    { latMin: -35, latMax:   5, lngMin:  -75, lngMax: -34 },
    { latMin:  -5, latMax:  37, lngMin:  -18, lngMax:  52 },
    { latMin:  -5, latMax:  55, lngMin:   60, lngMax: 120 },
];

function getRandomWorldPoint() {
    const region = SV_REGIONS[Math.floor(Math.random() * SV_REGIONS.length)];
    const lat = region.latMin + Math.random() * (region.latMax - region.latMin);
    const lng = region.lngMin + Math.random() * (region.lngMax - region.lngMin);
    return new google.maps.LatLng(lat, lng);
}

function getRandomNearbyPoint(center, maxRadiusMeters) {
    const heading  = Math.random() * 360;
    const distance = (0.3 + Math.random() * 0.7) * maxRadiusMeters;
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
            const randomStart = getRandomWorldPoint();

            const startPano = await getPanoramaAtPosition(randomStart, RANDOM_SV_RADIUS_M);
            if (!startPano?.location?.latLng) continue;
            const snappedStart = startPano.location.latLng;

            const randomEnd = getRandomNearbyPoint(snappedStart, RANDOM_END_RADIUS_M);

            const endPano = await getPanoramaAtPosition(randomEnd, RANDOM_SV_RADIUS_M);
            if (!endPano?.location?.latLng) continue;
            const snappedEnd = endPano.location.latLng;

            let response = await requestRoute(snappedStart, snappedEnd, google.maps.TravelMode.DRIVING);
            if (!response) {
                response = await requestRoute(snappedStart, snappedEnd, google.maps.TravelMode.WALKING);
            }
            if (!response) continue;

            const totalDistance = getRouteDistanceMeters(response);
            if (totalDistance < minMeters || totalDistance > maxMeters) continue;

            SvPlayer.reset();
            startLocation = snappedStart;
            endLocation   = snappedEnd;
            waypoints     = [];
            refreshWaypointMarkers();

            directionsRenderer.setDirections(response);
            route = extractRouteCoordinates(response);
            SvPlayer.onRouteChanged();

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
        if (btn) { btn.disabled = false; btn.textContent = "🌍 世界ランダム"; }
    }
}

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
                SvPlayer.onRouteChanged();
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
// =============================================
//  ★★★ 動画風ストリートビュー プレイヤー v3 ★★★
//
//  Street View Static API の静止画シーケンス方式。
//  - 全コマを <img> として事前読み込み(onloadで完了を確実に検知)
//  - 再生は読み込み済み画像の切り替えのみ → 黒画面が原理的に出ない
//  - ドラッグでPAN(5°刻みで画像を取り直し)。向きは移動後も維持
//  - 一時停止中は 🧭 でインタラクティブなパノラマに切替えて自由に見回し
//
//  ※ Google Cloud コンソールで「Street View Static API」を
//    有効にしておく必要があります(画像1枚 = 1リクエスト課金対象)
// =============================================
// =============================================
const SvPlayer = (() => {

    // ---- 状態 ----
    let frames = [];          // { position, panoId, baseHeading, cache: {key: {img, loaded}} }
    let framesDirty = true;
    let currentIndex = 0;
    let playing = false;
    let timer = null;
    let speed = 1;
    let prepared = false;
    let preparing = false;
    let prepToken = 0;        // 経路変更で進行中の解析/読み込みを破棄するトークン

    // ---- 視点(PAN)オフセット ----
    let headingOffset = 0;    // 進行方向からのズレ(度)
    let pitchOffset = 0;      // 上下方向のズレ(度)

    // ---- UI要素 ----
    let ui = {};
    let videoWrap = null;         // 画像レイヤーの親
    let imgLayers = [];           // [imgA, imgB] 前面/背面を入れ替えて使う
    let frontLayer = 0;           // imgLayers の表側インデックス
    let explorePano = null;       // 見回し用インタラクティブパノラマ(遅延生成)
    let exploreEl = null;
    let exploring = false;
    let progressMarker = null;
    let apiKey = "";
    let preloadDone = false;      // 全コマ読み込みが完了しているか

    // =========================================
    //  初期化
    // =========================================
    function init() {
        apiKey = detectApiKey();
        injectStyles();
        buildVideoLayers();
        injectPlayerBar();
        bindPointer();
        bindKeyboard();
        updateUi();
    }

    function detectApiKey() {
        const s = [...document.scripts].find((x) => (x.src || "").includes("maps.googleapis.com"));
        if (!s) return "";
        try { return new URL(s.src).searchParams.get("key") || ""; } catch { return ""; }
    }

    function onRouteChanged() {
        framesDirty = true;
        prepared = false;
        preloadDone = false;
        prepToken++;
        pause(true);
        frames = [];
        currentIndex = 0;
        headingOffset = 0;
        pitchOffset = 0;
        updateUi();
    }

    function reset() {
        onRouteChanged();
        if (progressMarker) { progressMarker.setMap(null); progressMarker = null; }
        closeExplore(false);
        setBarVisible(false);
    }

    // =========================================
    //  フレーム構築(経路→パノラマ解決)
    // =========================================
    function buildRawFrames() {
        frames = route.map((pt, i) => {
            const lookIdx = Math.min(i + LOOKAHEAD_POINTS, route.length - 1);
            const heading = (i >= route.length - 1 && route.length >= 2)
                ? google.maps.geometry.spherical.computeHeading(route[route.length - 2], pt)
                : google.maps.geometry.spherical.computeHeading(pt, route[lookIdx]);
            return { position: pt, panoId: null, baseHeading: heading, cache: {} };
        });
    }

    async function prepareFrames() {
        if (!framesDirty && prepared) return true;
        if (preparing) return false;

        preparing = true;
        const myToken = ++prepToken;
        buildRawFrames();

        if (frames.length === 0) { preparing = false; return false; }

        if (frames.length > PANO_PREP_MAX) {
            framesDirty = false;
            prepared = true;
            preparing = false;
            return true; // パノラマ解決なし(Static APIはlocation指定で取得)
        }

        setCounterText("解析中 0%");
        const sv = new google.maps.StreetViewService();

        const resolveOne = (frame) => new Promise((resolve) => {
            sv.getPanorama(
                { location: frame.position, radius: 60, source: google.maps.StreetViewSource.OUTDOOR },
                (data, status) => {
                    if (status === google.maps.StreetViewStatus.OK && data?.location) {
                        frame.panoId = data.location.pano || null;
                        if (data.location.latLng) frame.position = data.location.latLng;
                    }
                    resolve();
                }
            );
        });

        let done = 0;
        let cursor = 0;
        const workers = Array.from({ length: PANO_PREP_CONCURRENCY }, async () => {
            while (cursor < frames.length) {
                if (myToken !== prepToken) return;
                const idx = cursor++;
                await resolveOne(frames[idx]);
                done++;
                if (done % 5 === 0 || done === frames.length) {
                    setCounterText(`解析中 ${Math.round((done / frames.length) * 100)}%`);
                }
            }
        });
        await Promise.all(workers);

        if (myToken !== prepToken) { preparing = false; return false; }

        // 連続する同一パノラマを除去
        const deduped = [];
        for (const f of frames) {
            const prev = deduped[deduped.length - 1];
            if (prev && prev.panoId && f.panoId && prev.panoId === f.panoId) continue;
            deduped.push(f);
        }
        if (deduped.length >= 2) frames = deduped;

        // 間引き後にbaseHeadingを再計算
        for (let i = 0; i < frames.length - 1; i++) {
            const lookIdx = Math.min(i + LOOKAHEAD_POINTS, frames.length - 1);
            frames[i].baseHeading =
                google.maps.geometry.spherical.computeHeading(frames[i].position, frames[lookIdx].position);
        }
        if (frames.length >= 2) {
            frames[frames.length - 1].baseHeading =
                google.maps.geometry.spherical.computeHeading(
                    frames[frames.length - 2].position, frames[frames.length - 1].position);
        }

        framesDirty = false;
        prepared = true;
        preparing = false;
        return true;
    }

    // =========================================
    //  Static API 画像の取得・キャッシュ
    // =========================================
    function roundedHeading(frame) {
        const h = ((frame.baseHeading + headingOffset) % 360 + 360) % 360;
        return Math.round(h / HEADING_STEP) * HEADING_STEP % 360;
    }

    function roundedPitch() {
        const p = Math.max(-35, Math.min(35, pitchOffset));
        return Math.round(p / HEADING_STEP) * HEADING_STEP;
    }

    function imageUrl(frame, h, p) {
        const params = new URLSearchParams({
            size: STATIC_SIZE,
            fov: String(STATIC_FOV),
            heading: String(h),
            pitch: String(p),
            key: apiKey,
            return_error_code: "true",
        });
        if (frame.panoId) {
            params.set("pano", frame.panoId);
        } else {
            params.set("location", `${frame.position.lat()},${frame.position.lng()}`);
            params.set("radius", "60");
            params.set("source", "outdoor");
        }
        return `https://maps.googleapis.com/maps/api/streetview?${params.toString()}`;
    }

    // フレーム画像を(必要なら取得して)返す。読み込み完了で resolve
    function fetchFrameImage(frame, h = roundedHeading(frame), p = roundedPitch()) {
        const cacheKey = `h${h}_p${p}`;
        const hit = frame.cache[cacheKey];
        if (hit) return hit.promise;

        const img = new Image();
        const entry = { img, loaded: false };
        entry.promise = new Promise((resolve) => {
            img.onload  = () => { entry.loaded = true; resolve(img); };
            img.onerror = () => { entry.error = true; resolve(null); };
            img.src = imageUrl(frame, h, p);
        });
        frame.cache[cacheKey] = entry;
        return entry.promise;
    }

    function isFrameReady(frame) {
        const e = frame.cache[`h${roundedHeading(frame)}_p${roundedPitch()}`];
        return !!(e && e.loaded);
    }

    // 現在位置から先のコマを現在の視点向きで先読み
    function prefetchAhead(i) {
        for (let k = 0; k <= PREFETCH_AHEAD; k++) {
            const f = frames[i + k];
            if (f) fetchFrameImage(f);
        }
    }

    // =========================================
    //  ★ 全コマ事前読み込み(本命機能)
    // =========================================
    async function preloadAll() {
        const myToken = prepToken;
        const total = frames.length;
        let done = 0;
        let errors = 0;

        const jobs = frames.slice();
        const workers = Array.from({ length: IMG_CONCURRENCY }, async () => {
            while (jobs.length > 0) {
                if (myToken !== prepToken) return;
                const frame = jobs.shift();
                const img = await fetchFrameImage(frame);
                if (!img) errors++;
                done++;
                if (done % 3 === 0 || done === total) {
                    setCounterText(`読込 ${Math.round((done / total) * 100)}%`);
                }
                // 最初の数枚が全滅ならAPI未有効の可能性大 → 即中断して案内
                if (done >= 5 && errors >= done) {
                    alert(
                        "ストリートビュー画像を取得できませんでした。\n" +
                        "Google Cloud コンソールでこのAPIキーに対して\n" +
                        "「Street View Static API」が有効になっているか確認してください。"
                    );
                    return false;
                }
            }
        });
        await Promise.all(workers);

        if (myToken !== prepToken) return false;
        if (errors > 0 && errors >= total * 0.5) return false;
        preloadDone = true;
        return true;
    }

    // =========================================
    //  再生制御
    // =========================================
    async function start() {
        setBarVisible(true);
        const ok = await prepareFrames();
        if (!ok || frames.length === 0) { updateUi(); return; }

        if (frames.length > PRELOAD_CONFIRM_OVER) {
            if (!confirm(
                `${frames.length}コマの画像を事前読み込みします。` +
                `(Static APIリクエストが${frames.length}回発生します)\n実行しますか?`
            )) return;
        }

        const myToken = prepToken;
        currentIndex = 0;
        headingOffset = 0;
        pitchOffset = 0;

        // ★ 全コマを読み込み切ってから再生開始
        const loaded = await preloadAll();
        if (myToken !== prepToken) return;
        if (!loaded) { updateUi(); return; }

        showFrame(0);
        play();
    }

    function play() {
        if (playing) return;
        if (frames.length === 0) {
            if (route.length > 0) { start(); }
            return;
        }
        closeExplore();
        if (currentIndex >= frames.length - 1) currentIndex = 0;
        playing = true;
        scheduleTick();
        flashIcon("▶");
        updateUi();
    }

    function pause(silent = false) {
        if (timer) { clearTimeout(timer); timer = null; }
        if (playing && !silent) flashIcon("⏸");
        playing = false;
        updateUi();
    }

    function toggle() { playing ? pause() : play(); }

    function scheduleTick() {
        if (timer) clearTimeout(timer);
        timer = setTimeout(tick, BASE_INTERVAL_MS / speed);
    }

    function tick() {
        if (!playing) return;
        if (currentIndex >= frames.length - 1) {
            pause(true);
            flashIcon("🏁");
            return;
        }
        currentIndex++;
        showFrame(currentIndex);
        scheduleTick();
    }

    function seekTo(index) {
        if (frames.length === 0) return;
        currentIndex = Math.max(0, Math.min(index, frames.length - 1));
        closeExplore();
        showFrame(currentIndex);
        if (playing) scheduleTick();
    }

    function setSpeed(mult) {
        speed = mult;
        if (playing) scheduleTick();
        updateUi();
    }

    // =========================================
    //  フレーム表示(画像レイヤー入れ替え)
    // =========================================
    async function showFrame(index) {
        const frame = frames[index];
        if (!frame) return;

        map.setCenter(frame.position);
        updateProgressMarker(frame.position);
        updateUi();

        const img = await fetchFrameImage(frame);
        // 読み込み待ちの間に別コマへ進んでいたら破棄(前の画像が残る=黒画面は出ない)
        if (index !== currentIndex || !img) return;
        swapLayerTo(img.src);
    }

    function swapLayerTo(src) {
        const back = imgLayers[1 - frontLayer];
        back.src = src;
        back.classList.remove("back");
        back.classList.add("front");
        const old = imgLayers[frontLayer];
        old.classList.remove("front");
        old.classList.add("back");
        frontLayer = 1 - frontLayer;
    }

    // 視点(PAN)変更後の表示更新: 現在コマを新しい向きで取り直し、先読みも更新
    let povRefreshTimer = null;
    function refreshPov() {
        if (povRefreshTimer) return;
        povRefreshTimer = setTimeout(async () => {
            povRefreshTimer = null;
            const frame = frames[currentIndex];
            if (!frame) return;
            const img = await fetchFrameImage(frame);
            if (img && frame === frames[currentIndex]) swapLayerTo(img.src);
            prefetchAhead(currentIndex + 1);
            updateRecenterButton();
        }, POV_REFRESH_MS);
    }

    function recenter() {
        headingOffset = 0;
        pitchOffset = 0;
        refreshPov();
        updateRecenterButton();
    }

    // =========================================
    //  ドラッグPAN & タップ再生/停止
    // =========================================
    function bindPointer() {
        let downX = 0, downY = 0, downT = 0;
        let dragging = false;
        let lastX = 0, lastY = 0;

        videoWrap.addEventListener("pointerdown", (e) => {
            if (exploring) return;
            downX = lastX = e.clientX;
            downY = lastY = e.clientY;
            downT = Date.now();
            dragging = true;
            videoWrap.setPointerCapture(e.pointerId);
        });

        videoWrap.addEventListener("pointermove", (e) => {
            if (!dragging || exploring || frames.length === 0) return;
            const rect = videoWrap.getBoundingClientRect();
            const degPerPxH = STATIC_FOV / rect.width;
            const degPerPxV = (STATIC_FOV * 0.66) / rect.height;
            headingOffset -= (e.clientX - lastX) * degPerPxH;
            pitchOffset   += (e.clientY - lastY) * degPerPxV;
            pitchOffset = Math.max(-35, Math.min(35, pitchOffset));
            lastX = e.clientX;
            lastY = e.clientY;
            refreshPov();
        });

        videoWrap.addEventListener("pointerup", (e) => {
            dragging = false;
            if (exploring || frames.length === 0) return;
            const moved = Math.hypot(e.clientX - downX, e.clientY - downY);
            const elapsed = Date.now() - downT;
            if (moved < 6 && elapsed < 400) {
                if (e.target.closest("#sv-player-bar")) return;
                if (e.target.closest("button, a, [role='button']")) return;
                toggle();
            } else {
                prefetchAhead(currentIndex + 1); // ドラッグ終了 → 新しい向きで先読み
            }
        });

        videoWrap.addEventListener("pointercancel", () => { dragging = false; });
    }

    // =========================================
    //  🧭 見回しモード(インタラクティブSVに一時切替)
    // =========================================
    function openExplore() {
        const frame = frames[currentIndex];
        if (!frame) return;
        pause(true);

        if (!exploreEl) {
            exploreEl = document.createElement("div");
            exploreEl.id = "sv-explore";
            const closeBtn = document.createElement("button");
            closeBtn.id = "sv-explore-close";
            closeBtn.textContent = "✕ 動画に戻る";
            closeBtn.addEventListener("click", () => closeExplore());
            const inner = document.createElement("div");
            inner.id = "sv-explore-pano";
            exploreEl.append(inner, closeBtn);
            videoWrap.appendChild(exploreEl);
            explorePano = new google.maps.StreetViewPanorama(inner, {
                pov: { heading: 0, pitch: 0 },
                zoom: 1,
                addressControl: false,
                motionTracking: false,
                motionTrackingControl: false,
                fullscreenControl: false,
            });
        }

        if (frame.panoId) explorePano.setPano(frame.panoId);
        else explorePano.setPosition(frame.position);
        explorePano.setPov({
            heading: ((frame.baseHeading + headingOffset) % 360 + 360) % 360,
            pitch: Math.max(-35, Math.min(35, pitchOffset)),
        });

        exploreEl.style.display = "block";
        exploring = true;
        google.maps.event.trigger(explorePano, "resize");
        updateUi();
    }

    // 見回しで変えた向きを動画側に引き継いで閉じる
    function closeExplore(applyPov = true) {
        if (!exploring) return;
        exploring = false;
        if (applyPov && explorePano && frames[currentIndex]) {
            const pov = explorePano.getPov();
            if (pov) {
                headingOffset = normalizeDeg(pov.heading - frames[currentIndex].baseHeading);
                pitchOffset = Math.max(-35, Math.min(35, pov.pitch ?? 0));
                refreshPov();
            }
        }
        if (exploreEl) exploreEl.style.display = "none";
        updateUi();
    }

    function normalizeDeg(deg) {
        let d = deg % 360;
        if (d > 180)  d -= 360;
        if (d < -180) d += 360;
        return d;
    }

    // =========================================
    //  地図上の現在位置マーカー
    // =========================================
    function updateProgressMarker(position) {
        if (!progressMarker) {
            progressMarker = new google.maps.Marker({
                position, map,
                zIndex: 999,
                icon: {
                    path: google.maps.SymbolPath.CIRCLE,
                    scale: 7,
                    fillColor: "#00d4ff",
                    fillOpacity: 1,
                    strokeColor: "#ffffff",
                    strokeWeight: 2,
                },
            });
        } else {
            progressMarker.setPosition(position);
        }
    }

    // =========================================
    //  UI構築
    // =========================================
    function buildVideoLayers() {
        videoWrap = document.getElementById("street-view");
        if (!videoWrap) return;
        for (let k = 0; k < 2; k++) {
            const img = document.createElement("img");
            img.className = "sv-pane " + (k === 0 ? "front" : "back");
            img.alt = "";
            img.draggable = false;
            videoWrap.appendChild(img);
            imgLayers.push(img);
        }
        frontLayer = 0;
    }

    function injectStyles() {
        const css = `
        #street-view { background: #0a0e1a; touch-action: none; user-select: none; }
        /* 画像レイヤー(表:front / 裏:back) */
        img.sv-pane {
            position: absolute;
            inset: 0;
            width: 100%;
            height: 100%;
            object-fit: cover;
            opacity: 1;
        }
        .sv-pane.front { z-index: 3; animation: svFadeIn 0.22s ease; }
        .sv-pane.back  { z-index: 1; }
        @keyframes svFadeIn { from { opacity: 0; } to { opacity: 1; } }
        .sv-tap-hint { z-index: 21; }
        /* 見回しモード */
        #sv-explore {
            position: absolute;
            inset: 0;
            z-index: 24;
            display: none;
        }
        #sv-explore-pano { position: absolute; inset: 0; }
        #sv-explore-close {
            position: absolute;
            top: 10px; left: 10px;
            z-index: 26;
            background: rgba(10,14,26,0.85);
            color: #00d4ff;
            border: 1px solid rgba(0,212,255,0.4);
            border-radius: 8px;
            padding: 7px 14px;
            font-size: 0.8rem;
            font-weight: 700;
            cursor: pointer;
        }
        #sv-player-bar {
            position: absolute;
            left: 10px; right: 10px; bottom: 10px;
            z-index: 25;
            display: none;
            align-items: center;
            gap: 8px;
            padding: 8px 12px;
            background: rgba(10,14,26,0.82);
            backdrop-filter: blur(8px);
            border: 1px solid rgba(0,212,255,0.25);
            border-radius: 12px;
            font-family: 'Noto Sans JP', sans-serif;
        }
        #sv-player-bar.visible { display: flex; }
        #sv-player-bar button {
            background: transparent;
            border: 1px solid rgba(0,212,255,0.3);
            color: #00d4ff;
            border-radius: 8px;
            font-size: 0.85rem;
            padding: 4px 9px;
            cursor: pointer;
            line-height: 1;
            transition: all 0.15s;
            flex-shrink: 0;
        }
        #sv-player-bar button:hover { background: rgba(0,212,255,0.12); }
        #sv-player-bar button:disabled { opacity: 0.35; cursor: not-allowed; }
        #sv-player-bar button.active { background: rgba(0,212,255,0.25); box-shadow: 0 0 8px rgba(0,212,255,0.4); }
        #sv-seek {
            flex: 1;
            min-width: 60px;
            accent-color: #00d4ff;
            cursor: pointer;
            height: 4px;
        }
        #sv-counter {
            font-size: 0.68rem;
            color: #7a90b0;
            white-space: nowrap;
            min-width: 64px;
            text-align: center;
            flex-shrink: 0;
            font-variant-numeric: tabular-nums;
        }
        #sv-speed {
            background: rgba(26,34,54,0.9);
            color: #e0eaf8;
            border: 1px solid rgba(0,212,255,0.3);
            border-radius: 8px;
            font-size: 0.72rem;
            padding: 4px 4px;
            cursor: pointer;
            flex-shrink: 0;
        }
        #sv-flash {
            position: absolute;
            top: 50%; left: 50%;
            transform: translate(-50%, -50%);
            z-index: 15;
            font-size: 3.2rem;
            pointer-events: none;
            opacity: 0;
            filter: drop-shadow(0 0 16px rgba(0,212,255,0.8));
        }
        #sv-flash.flash { animation: svFlash 0.7s ease-out forwards; }
        @keyframes svFlash {
            0%   { opacity: 0.95; transform: translate(-50%, -50%) scale(0.8); }
            100% { opacity: 0;    transform: translate(-50%, -50%) scale(1.5); }
        }
        /* 旧オーバーレイは無効化 */
        #sv-tap-overlay { pointer-events: none !important; display: none !important; }
        @media (max-width: 520px) {
            #sv-player-bar { flex-wrap: wrap; gap: 6px; padding: 7px 9px; }
            #sv-seek { flex-basis: 100%; order: -1; }
        }`;
        const style = document.createElement("style");
        style.textContent = css;
        document.head.appendChild(style);
    }

    function injectPlayerBar() {
        const svWrap = document.getElementById("street-view");
        if (!svWrap) return;

        const bar = document.createElement("div");
        bar.id = "sv-player-bar";
        bar.innerHTML = `
            <button id="sv-prev"  title="1つ戻る">⏮</button>
            <button id="sv-play"  title="再生 / 一時停止">▶</button>
            <button id="sv-next"  title="1つ進む">⏭</button>
            <input  id="sv-seek" type="range" min="0" max="0" value="0" step="1">
            <span   id="sv-counter">- / -</span>
            <select id="sv-speed" title="再生速度">
                <option value="0.5">0.5x</option>
                <option value="1" selected>1x</option>
                <option value="1.5">1.5x</option>
                <option value="2">2x</option>
                <option value="3">3x</option>
            </select>
            <button id="sv-recenter" title="進行方向に視点を戻す">⌖</button>
            <button id="sv-explore-btn" title="この地点を自由に見回す">🧭</button>
        `;
        svWrap.appendChild(bar);

        const flash = document.createElement("div");
        flash.id = "sv-flash";
        svWrap.appendChild(flash);

        ui = {
            bar,
            flash,
            play:     bar.querySelector("#sv-play"),
            prev:     bar.querySelector("#sv-prev"),
            next:     bar.querySelector("#sv-next"),
            seek:     bar.querySelector("#sv-seek"),
            counter:  bar.querySelector("#sv-counter"),
            speedSel: bar.querySelector("#sv-speed"),
            recenter: bar.querySelector("#sv-recenter"),
            explore:  bar.querySelector("#sv-explore-btn"),
        };

        ["click", "pointerdown", "pointerup", "pointermove", "touchstart"].forEach((ev) =>
            bar.addEventListener(ev, (e) => e.stopPropagation())
        );

        ui.play.addEventListener("click", toggle);
        ui.prev.addEventListener("click", () => seekTo(currentIndex - 1));
        ui.next.addEventListener("click", () => seekTo(currentIndex + 1));
        ui.seek.addEventListener("input", () => seekTo(parseInt(ui.seek.value, 10)));
        ui.speedSel.addEventListener("change", () => setSpeed(parseFloat(ui.speedSel.value)));
        ui.recenter.addEventListener("click", recenter);
        ui.explore.addEventListener("click", () => (exploring ? closeExplore() : openExplore()));
    }

    function setBarVisible(visible) {
        if (ui.bar) ui.bar.classList.toggle("visible", visible);
    }

    function updateUi() {
        if (!ui.bar) return;
        const total = frames.length;
        ui.play.textContent = playing ? "⏸" : "▶";
        ui.seek.max = Math.max(0, total - 1);
        ui.seek.value = currentIndex;
        ui.seek.disabled = total === 0;
        ui.counter.textContent = total > 0 ? `${currentIndex + 1} / ${total}` : "- / -";
        ui.prev.disabled = total === 0 || currentIndex <= 0;
        ui.next.disabled = total === 0 || currentIndex >= total - 1;
        ui.explore.disabled = total === 0;
        ui.explore.classList.toggle("active", exploring);
    }

    function updateRecenterButton() {
        if (!ui.recenter) return;
        ui.recenter.classList.toggle(
            "active",
            Math.abs(headingOffset) > 5 || Math.abs(pitchOffset) > 5
        );
    }

    function setCounterText(text) {
        if (ui.counter) ui.counter.textContent = text;
    }

    function flashIcon(icon) {
        if (!ui.flash) return;
        ui.flash.textContent = icon;
        ui.flash.classList.remove("flash");
        void ui.flash.offsetWidth;
        ui.flash.classList.add("flash");
    }

    // =========================================
    //  キーボード操作(スペース / Shift+←→)
    // =========================================
    function bindKeyboard() {
        document.addEventListener("keydown", (e) => {
            const tag = (e.target.tagName || "").toLowerCase();
            if (tag === "input" || tag === "textarea" || tag === "select") return;
            if (frames.length === 0) return;

            if (e.code === "Space") {
                e.preventDefault();
                toggle();
            } else if (e.code === "ArrowRight" && e.shiftKey) {
                e.preventDefault();
                seekTo(currentIndex + 1);
            } else if (e.code === "ArrowLeft" && e.shiftKey) {
                e.preventDefault();
                seekTo(currentIndex - 1);
            } else if (e.code === "Escape" && exploring) {
                closeExplore();
            }
        });
    }

    // ---- 公開API ----
    return { init, start, play, pause, toggle, seekTo, setSpeed, reset, onRouteChanged };
})();

// =============================================
//  エントリーポイント
// =============================================
window.onload = initMap;
