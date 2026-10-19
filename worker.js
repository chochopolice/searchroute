// =============================================
//  searchroute: Street View Static API 署名付きプロキシ (Cloudflare Worker)
//
//  ブラウザ → この Worker → Google の順に画像を中継する。
//  APIキーと署名シークレットは Worker の中にだけ置き、ブラウザには出さない。
//
//  Cloudflare ダッシュボード → この Worker → Settings → Variables and Secrets に登録:
//    SV_KEY             (Secret) Street View Static API 専用の新しいAPIキー
//    SV_SIGNING_SECRET  (Secret) Google Maps Platform「認証情報」の URL署名シークレット
//    ALLOWED_ORIGINS    (Text)   画像の読み込みを許可するサイト。カンマ区切りで複数可
//                                例: https://chochopolice.github.io
//                                ※ パス(/searchroute)や末尾の / は付けない
//
//  呼び出し例:
//    https://<Worker名>.<サブドメイン>.workers.dev/sv?pano=XXXX&heading=90&pitch=0&fov=90&size=640x400
//    https://<Worker名>.<サブドメイン>.workers.dev/sv?location=35.6812360,139.7671250&heading=90
// =============================================

const GOOGLE_ORIGIN = "https://maps.googleapis.com";
const MAX_SIZE = 640;              // Street View Static API の画像サイズ上限
const DEFAULT_SIZE = "640x400";

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        if (request.method !== "GET" && request.method !== "HEAD") {
            return text("Method Not Allowed", 405);
        }
        if (url.pathname !== "/sv") {
            return text("Not Found", 404);
        }

        // ---- 1) 呼び出し元チェック ----
        // <img> の読み込みでは Origin ヘッダーが付かないため Referer で判定する。
        // 別サイトへのリクエストでは Referer がオリジン(https://xxx.github.io/)だけに
        // 短縮されるので、オリジン単位で比較する。
        const allowed = (env.ALLOWED_ORIGINS || "")
            .split(",")
            .map((s) => s.trim().replace(/\/+$/, ""))
            .filter(Boolean);
        const refOrigin = originOf(request.headers.get("Referer"));
        if (!refOrigin || !allowed.includes(refOrigin)) {
            return text("Forbidden: referer not allowed", 403);
        }

        // ---- 2) 設定チェック ----
        if (!env.SV_KEY || !env.SV_SIGNING_SECRET) {
            return text("Worker is not configured (SV_KEY / SV_SIGNING_SECRET)", 500);
        }

        // ---- 3) パラメータ検証(想定外の値は Google に送らない) ----
        const q = url.searchParams;
        const params = new URLSearchParams();

        const size = q.get("size") || DEFAULT_SIZE;
        const m = /^(\d{2,3})x(\d{2,3})$/.exec(size);
        if (!m || Number(m[1]) > MAX_SIZE || Number(m[2]) > MAX_SIZE) {
            return text("Bad request: size", 400);
        }
        params.set("size", size);

        const pano = q.get("pano");
        const location = q.get("location");
        if (pano) {
            if (!/^[A-Za-z0-9_.-]{10,300}$/.test(pano)) return text("Bad request: pano", 400);
            params.set("pano", pano);
        } else if (location) {
            if (!/^-?\d{1,2}(\.\d+)?,-?\d{1,3}(\.\d+)?$/.test(location)) {
                return text("Bad request: location", 400);
            }
            params.set("location", location);
            params.set("radius", String(clampInt(q.get("radius"), 1, 1000, 60)));
            params.set("source", q.get("source") === "default" ? "default" : "outdoor");
        } else {
            return text("Bad request: pano or location is required", 400);
        }

        params.set("heading", String(clampNum(q.get("heading"), 0, 360, 0)));
        params.set("pitch", String(clampNum(q.get("pitch"), -90, 90, 0)));
        params.set("fov", String(clampNum(q.get("fov"), 10, 120, 90)));
        // 画像が無い場所で灰色の画像(200)ではなくエラー(404)を返させる。
        // これが無いと app.js の「pano指定 → location指定」の自動切り替えが動かない
        params.set("return_error_code", "true");
        params.set("key", env.SV_KEY);

        // ---- 4) 署名して Google へ ----
        const path = `/maps/api/streetview?${params.toString()}`;
        let signature;
        try {
            signature = await signPath(path, env.SV_SIGNING_SECRET);
        } catch (e) {
            return text("Signing failed: check SV_SIGNING_SECRET", 500);
        }

        const upstream = await fetch(`${GOOGLE_ORIGIN}${path}&signature=${signature}`);

        if (!upstream.ok) {
            // Cloudflare の Logs で確認できる(キーは出さない)
            console.log(
                `google status=${upstream.status} ` +
                (pano ? `pano=${pano}` : `location=${location}`)
            );
        }

        // ---- 5) ブラウザへ返す ----
        // キャッシュは Google が返した指定にそのまま従う(独自に長期キャッシュしない)
        const headers = new Headers();
        headers.set("Content-Type", upstream.headers.get("Content-Type") || "image/jpeg");
        headers.set(
            "Cache-Control",
            upstream.ok ? (upstream.headers.get("Cache-Control") || "private, max-age=3600") : "no-store"
        );
        headers.set("Access-Control-Allow-Origin", refOrigin);
        headers.set("Vary", "Referer");
        headers.set("X-Content-Type-Options", "nosniff");

        return new Response(request.method === "HEAD" ? null : upstream.body, {
            status: upstream.status,
            headers,
        });
    },
};

// URL署名: Google から発行されたシークレット(URL-safe Base64)で
// 「パス + クエリ」の HMAC-SHA1 を計算し、URL-safe Base64 で返す
export async function signPath(pathAndQuery, secretB64Url) {
    const raw = atob(secretB64Url.trim().replace(/-/g, "+").replace(/_/g, "/"));
    const keyBytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey(
        "raw", keyBytes, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(pathAndQuery));
    return btoa(String.fromCharCode(...new Uint8Array(sig)))
        .replace(/\+/g, "-")
        .replace(/\//g, "_");
}

function originOf(referer) {
    if (!referer) return null;
    try { return new URL(referer).origin; } catch { return null; }
}

function clampNum(value, min, max, fallback) {
    const n = Number(value);
    if (value === null || value === "" || !Number.isFinite(n)) return fallback;
    return Math.round(Math.min(max, Math.max(min, n)) * 100) / 100;
}

function clampInt(value, min, max, fallback) {
    return Math.round(clampNum(value, min, max, fallback));
}

function text(body, status) {
    return new Response(body, {
        status,
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
}
