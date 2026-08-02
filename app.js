// =============================================
//  Google Maps ストリートビュー 散歩アプリ
//  v2: 動画風プレイヤー(シーク/速度/PANオフセット追従)
// =============================================

// --- グローバル変数 ---
let geocoder;
let map, panorama;
let panoA, panoB;               // ★ ダブルバッファ用の2枚のパノラマ
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
const PRELOAD_DWELL_MS      = 500; // 全読込モードで1コマあたりに待つ時間(ms)
const PRELOAD_CONFIRM_OVER  = 150; // このコマ数を超える全読込は確認ダイアログを出す

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

    // ★ ダブルバッファ: 表示用と先読み用の2枚のパノラマを重ねて生成。
    //    次のコマは常に裏側のパノラマで先に読み込み、表示を入れ替えることで
    //    黒画面・低解像度のまま進む問題を防ぐ。
    const svWrap = document.getElementById("street-view");
    const paneA = document.createElement("div");
    const paneB = document.createElement("div");
    paneA.className = "sv-pane front";
    paneB.className = "sv-pane back";
    svWrap.append(paneA, paneB);

    const PANO_OPTIONS = {
        pov: { heading: 0, pitch: 0 },
        zoom: 1,
        // 動画風の見た目のため標準UIを最小化(パン操作は可能なまま)
        addressControl: false,
        fullscreenControl: false,   // 全画面は2枚構成と相性が悪いため無効化
        motionTracking: false,
        motionTrackingControl: false,
    };
    panoA = new google.maps.StreetViewPanorama(paneA, { ...PANO_OPTIONS, position: begin });
    panoB = new google.maps.StreetViewPanorama(paneB, { ...PANO_OPTIONS, position: begin });
    panoA._svPane = paneA;
    panoB._svPane = paneB;
    panorama = panoA; // 表示中(アクティブ)のパノラマ

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
//  ★★★ 動画風ストリートビュー プレイヤー ★★★
//
//  - フレーム列(経路ポイント→パノラマ)を事前計算しシーク可能に
//  - 再生 / 一時停止 / シークバー / 速度変更
//  - ユーザーのPAN操作を「進行方向からのオフセット」として保持し、
//    移動後も向きを維持(視聴中・一時停止中いつでもPAN可能)
// =============================================
// =============================================
const SvPlayer = (() => {

    // ---- 状態 ----
    let frames = [];          // { position: LatLng, panoId: string|null, baseHeading: number }
    let framesDirty = true;   // routeが変わったら再構築が必要
    let currentIndex = 0;
    let playing = false;
    let timer = null;
    let speed = 1;            // 再生速度倍率
    let prepared = false;     // フレーム構築済みか
    let preparing = false;
    let prepToken = 0;        // 経路変更時に進行中の解析を破棄するためのトークン

    // ---- ダブルバッファ ----
    let activeP = null;           // 表示中のパノラマ
    let bufferP = null;           // 先読み用(非表示)のパノラマ
    let bufferFrameIndex = -1;    // bufferPが読み込んでいるフレーム番号
    let preloadRunning = false;   // 全読込モード実行中か
    let preloadToken = 0;         // 全読込モードの中断用トークン

    // ---- PANオフセット ----
    let headingOffset = 0;        // 進行方向(baseHeading)からのユーザー視点のズレ
    let currentBaseHeading = 0;
    let expectedHeading = null;   // 自分でsetPovした値(pov_changedの自他判定用)

    // ---- UI要素 ----
    let ui = {};
    let progressMarker = null;    // 地図上の現在位置マーカー

    // =========================================
    //  初期化(UI注入 + イベント)
    // =========================================
    function init() {
        activeP = panoA;
        bufferP = panoB;
        injectStyles();
        injectPlayerBar();
        bindPanoramaEvents();
        bindTapToggle();
        bindKeyboard();
        updateUi();
    }

    function onRouteChanged() {
        framesDirty = true;
        prepared = false;
        prepToken++;          // 進行中の解析を無効化
        preloadToken++;       // 進行中の全読込を中断
        bufferFrameIndex = -1;
        pause(true);
        frames = [];          // 旧経路のフレームを破棄(次回startで再構築)
        currentIndex = 0;
        headingOffset = 0;
        updateUi();
    }

    function reset() {
        onRouteChanged();
        if (progressMarker) { progressMarker.setMap(null); progressMarker = null; }
        setBarVisible(false);
    }

    // =========================================
    //  フレーム構築
    // =========================================
    function buildRawFrames() {
        frames = route.map((pt, i) => {
            const lookIdx = Math.min(i + LOOKAHEAD_POINTS, route.length - 1);
            const heading = (i >= route.length - 1 && route.length >= 2)
                ? google.maps.geometry.spherical.computeHeading(route[route.length - 2], pt)
                : google.maps.geometry.spherical.computeHeading(pt, route[lookIdx]);
            return { position: pt, panoId: null, baseHeading: heading };
        });
    }

    // パノラマIDを事前解決し、連続する同一パノラマを間引く(=カクつき削減 & 正確なシーク)
    async function prepareFrames() {
        if (!framesDirty && prepared) return true;
        if (preparing) return false;

        preparing = true;
        const myToken = ++prepToken;
        buildRawFrames();

        if (frames.length === 0) { preparing = false; return false; }

        // ポイント数が多すぎる場合は事前解決をスキップ(生ポイントのまま再生)
        if (frames.length > PANO_PREP_MAX) {
            framesDirty = false;
            prepared = true;
            preparing = false;
            return true;
        }

        setPrepProgress(0);
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

        // 同時実行数を絞ったプール処理
        let done = 0;
        let cursor = 0;
        const workers = Array.from({ length: PANO_PREP_CONCURRENCY }, async () => {
            while (cursor < frames.length) {
                if (myToken !== prepToken) return; // 経路が変わったので中断
                const idx = cursor++;
                await resolveOne(frames[idx]);
                done++;
                if (done % 5 === 0 || done === frames.length) {
                    setPrepProgress(done / frames.length);
                }
            }
        });
        await Promise.all(workers);

        if (myToken !== prepToken) { preparing = false; return false; }

        // 連続する同一パノラマを除去(未解決 null は残す)
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
        setPrepProgress(null);
        return true;
    }

    // =========================================
    //  再生制御
    // =========================================
    async function start() {
        setBarVisible(true);
        const ok = await prepareFrames();
        if (!ok || frames.length === 0) { updateUi(); return; }
        currentIndex = 0;
        headingOffset = 0;
        showFrame(0);
        play();
    }

    function play() {
        if (playing) return;
        if (frames.length === 0) {
            // 「再開」ボタンから直接来た場合など、未構築なら構築から
            if (route.length > 0) { start(); }
            return;
        }
        if (currentIndex >= frames.length - 1) currentIndex = 0; // 終端からは先頭へ
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
        const next = currentIndex + 1;
        if (bufferFrameIndex === next) {
            // ★ 裏で読み込み済みのパノラマを表に出す(黒画面なしのクロスフェード切替)
            swapBuffers();
            currentIndex = next;
            const frame = frames[next];
            map.setCenter(frame.position);
            updateProgressMarker(frame.position);
            applyPov(frame.baseHeading);
            updateUi();
            preloadNext(next + 1);
        } else {
            // フォールバック(シーク直後・先読み未完了時)
            currentIndex = next;
            showFrame(next);
        }
        scheduleTick();
    }

    function seekTo(index) {
        if (frames.length === 0) return;
        currentIndex = Math.max(0, Math.min(index, frames.length - 1));
        showFrame(currentIndex);
        if (playing) scheduleTick(); // タイマーを打ち直す
    }

    function setSpeed(mult) {
        speed = mult;
        if (playing) scheduleTick();
        updateUi();
    }

    // =========================================
    //  フレーム表示 & ダブルバッファ
    // =========================================
    function setFrameOn(p, frame) {
        if (frame.panoId) {
            p.setPano(frame.panoId);
        } else {
            p.setPosition(frame.position);
        }
    }

    // 次のフレームを裏側のパノラマで先読みしておく
    function preloadNext(i) {
        if (!bufferP || !frames[i]) { bufferFrameIndex = -1; return; }
        setFrameOn(bufferP, frames[i]);
        mirrorBufferPov(i);
        bufferFrameIndex = i;
    }

    // 表示用と先読み用を入れ替える(先読み済みの絵が即座に表示される)
    function swapBuffers() {
        [activeP, bufferP] = [bufferP, activeP];
        panorama = activeP; // 外部参照用のグローバルも更新
        activeP._svPane.classList.remove("back");
        activeP._svPane.classList.add("front");
        bufferP._svPane.classList.remove("front");
        bufferP._svPane.classList.add("back");
        map.setStreetView(activeP);
    }

    function showFrame(index) {
        const frame = frames[index];
        if (!frame) return;

        setFrameOn(activeP, frame);
        map.setCenter(frame.position);
        updateProgressMarker(frame.position);
        applyPov(frame.baseHeading);
        updateUi();
        preloadNext(index + 1);
    }

    // 進行方向 + ユーザーオフセット でPOVを適用
    function applyPov(baseHeading) {
        currentBaseHeading = baseHeading;
        const pov = activeP.getPov() || { heading: 0, pitch: 0 };
        const heading = norm360(baseHeading + headingOffset);
        expectedHeading = heading;
        activeP.setPov({ heading, pitch: pov.pitch ?? 0 }); // pitchはユーザーの値を維持
    }

    // 先読み側のPOVを「そのフレームの進行方向 + 現在のオフセット」に合わせておく
    // (ユーザーが横を向いていたら、次のコマも横向きの状態で読み込まれる)
    function mirrorBufferPov(frameIndex = bufferFrameIndex) {
        if (!bufferP || frameIndex < 0 || !frames[frameIndex]) return;
        const pov = activeP.getPov() || { pitch: 0 };
        bufferP.setPov({
            heading: norm360(frames[frameIndex].baseHeading + headingOffset),
            pitch: pov.pitch ?? 0,
        });
    }

    // ユーザーのPAN操作を検知してオフセットを更新
    function bindPanoramaEvents() {
        [panoA, panoB].forEach((p) => {
            p.addListener("pov_changed", () => {
                if (p !== activeP) return; // 先読み側のPOV変更は無視
                const pov = p.getPov();
                if (pov == null) return;
                // 自分がsetPovした変更なら無視(非同期発火でも安全な値比較方式)
                if (expectedHeading !== null && Math.abs(normalizeDeg(pov.heading - expectedHeading)) < 0.01) {
                    return;
                }
                // ユーザー操作 → 進行方向からのズレを記録し、先読み側にも反映
                headingOffset = normalizeDeg(pov.heading - currentBaseHeading);
                mirrorBufferPov();
                updateRecenterButton();
            });

            // ユーザーが矢印リンクで自力移動した場合もマップを追従
            p.addListener("position_changed", () => {
                if (p !== activeP) return;
                const pos = p.getPosition();
                if (pos) updateProgressMarker(pos);
            });
        });
    }

    function recenter() {
        headingOffset = 0;
        applyPov(currentBaseHeading);
        mirrorBufferPov();
        updateRecenterButton();
    }

    function norm360(deg) {
        return ((deg % 360) + 360) % 360;
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
    //  プレイヤーバー UI
    // =========================================
    function injectStyles() {
        const css = `
        /* ダブルバッファ用パノラマ2枚(表:front / 裏:back) */
        .sv-pane {
            position: absolute;
            inset: 0;
            transition: opacity 0.25s ease;
        }
        .sv-pane.front { z-index: 2; opacity: 1; }
        .sv-pane.back  { z-index: 1; opacity: 0; pointer-events: none; }
        .sv-tap-hint { z-index: 21; }
        #sv-player-bar {
            position: absolute;
            left: 10px; right: 10px; bottom: 10px;
            z-index: 20;
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
        /* 旧オーバーレイはPAN操作を妨げるため無効化 */
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
            <button id="sv-preload"  title="全コマを事前読み込み(もう一度押すと中断)">⇣</button>
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
            preload:  bar.querySelector("#sv-preload"),
        };

        // バー内の操作がタップ再生/停止トグルに伝播しないように
        ["click", "pointerdown", "pointerup", "touchstart"].forEach((ev) =>
            bar.addEventListener(ev, (e) => e.stopPropagation())
        );

        ui.play.addEventListener("click", toggle);
        ui.prev.addEventListener("click", () => seekTo(currentIndex - 1));
        ui.next.addEventListener("click", () => seekTo(currentIndex + 1));
        ui.seek.addEventListener("input", () => seekTo(parseInt(ui.seek.value, 10)));
        ui.speedSel.addEventListener("change", () => setSpeed(parseFloat(ui.speedSel.value)));
        ui.recenter.addEventListener("click", recenter);
        ui.preload.addEventListener("click", prewarmAll);
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
    }

    function updateRecenterButton() {
        if (!ui.recenter) return;
        ui.recenter.classList.toggle("active", Math.abs(headingOffset) > 5);
    }

    function setPrepProgress(ratio) {
        if (!ui.counter) return;
        if (ratio === null) { updateUi(); return; }
        ui.counter.textContent = `解析中 ${Math.round(ratio * 100)}%`;
    }

    function flashIcon(icon) {
        if (!ui.flash) return;
        ui.flash.textContent = icon;
        ui.flash.classList.remove("flash");
        void ui.flash.offsetWidth; // reflowでアニメーション再発火
        ui.flash.classList.add("flash");
    }

    // =========================================
    //  全コマ事前読み込み(プリウォーム)モード
    //  裏側のパノラマで全フレームを順に表示し、タイルを
    //  ブラウザのキャッシュに載せてから再生する
    // =========================================
    async function prewarmAll() {
        if (preloadRunning) { preloadToken++; return; } // 実行中にもう一度押すと中断

        if (route.length === 0) { alert("有効な経路がありません。"); return; }
        setBarVisible(true);
        const ok = await prepareFrames();
        if (!ok || frames.length === 0) return;

        if (frames.length > PRELOAD_CONFIRM_OVER) {
            const sec = Math.ceil((frames.length * PRELOAD_DWELL_MS) / 1000);
            if (!confirm(`${frames.length}コマあります。全読込には約${sec}秒かかります。実行しますか?\n(実行中に ⇣ をもう一度押すと中断できます)`)) return;
        }

        preloadRunning = true;
        const myToken = ++preloadToken;
        pause(true);
        if (ui.preload) ui.preload.classList.add("active");

        try {
            for (let i = 0; i < frames.length; i++) {
                if (myToken !== preloadToken) return; // 中断 or 経路変更
                setFrameOn(bufferP, frames[i]);
                bufferFrameIndex = i;
                if (ui.counter) {
                    ui.counter.textContent = `読込 ${Math.round(((i + 1) / frames.length) * 100)}%`;
                }
                await new Promise((r) => setTimeout(r, PRELOAD_DWELL_MS));
            }
            flashIcon("✔");
        } finally {
            preloadRunning = false;
            if (ui.preload) ui.preload.classList.remove("active");
            if (myToken === preloadToken) {
                preloadNext(currentIndex + 1); // 先読みを現在位置基準に戻す
                updateUi();
            }
        }
    }

    // =========================================
    //  タップで再生/一時停止(ドラッグPANとは区別)
    // =========================================
    function bindTapToggle() {
        const svWrap = document.getElementById("street-view");
        if (!svWrap) return;

        let downX = 0, downY = 0, downT = 0;

        svWrap.addEventListener("pointerdown", (e) => {
            downX = e.clientX; downY = e.clientY; downT = Date.now();
        }, true);

        svWrap.addEventListener("pointerup", (e) => {
            if (frames.length === 0) return;
            const moved = Math.hypot(e.clientX - downX, e.clientY - downY);
            const elapsed = Date.now() - downT;
            // 動かさず短くタップした場合のみトグル(ドラッグ=PAN操作は無視)
            if (moved < 6 && elapsed < 400) {
                // プレイヤーバーやGoogle標準UIのクリックは除外
                if (e.target.closest("#sv-player-bar")) return;
                if (e.target.closest("button, a, [role='button']")) return;
                toggle();
            }
        }, true);
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
