/**
 * reports-invoices-worker
 *
 * Old behaviour: accepted one fixed string as a bearer token. That string sat
 * in app.js in a public repository, so anyone who read the source could
 * upload, download and delete invoice documents.
 *
 * New behaviour: the browser sends a Firebase ID token.
 *   Authorization: Bearer <idToken>
 * The signature is checked against Google's published keys, and the token must
 * belong to this Firebase project and carry an allowed email address. Such a
 * token cannot be forged, expires within the hour, and never appears in the
 * source.
 *
 * Deployed from GitHub via Workers Builds.
 *
 * Routes (unchanged, so the app keeps working the same way):
 *   PUT    /upload/<key>   upload
 *   GET    /file/<key>     download
 *   DELETE /file/<key>     delete
 */

const FIREBASE_PROJECT_ID = "reports-project-e8f66";

const DB_URL =
  "https://reports-project-e8f66-default-rtdb.asia-southeast1.firebasedatabase.app";

const ALLOWED_ORIGINS = [
  "https://reports.sramesh.in",
  "http://localhost:8080",
];

const JWKS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

// ---------------------------------------------------------------- CORS

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function json(body, status, request) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(request) },
  });
}

// ---------------------------------------------------------------- JWT

function b64urlToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlToJson(s) {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));
}

let jwksCache = { keys: null, fetchedAt: 0 };

async function getKey(kid) {
  const oneHour = 60 * 60 * 1000;
  if (!jwksCache.keys || Date.now() - jwksCache.fetchedAt > oneHour) {
    const res = await fetch(JWKS_URL);
    if (!res.ok) throw new Error("jwks fetch failed");
    const data = await res.json();
    jwksCache = { keys: data.keys || [], fetchedAt: Date.now() };
  }
  let jwk = jwksCache.keys.find((k) => k.kid === kid);

  // Google rotates keys. If the kid is unknown, refetch once before giving up.
  if (!jwk) {
    const res = await fetch(JWKS_URL);
    if (!res.ok) throw new Error("jwks refetch failed");
    const data = await res.json();
    jwksCache = { keys: data.keys || [], fetchedAt: Date.now() };
    jwk = jwksCache.keys.find((k) => k.kid === kid);
  }
  if (!jwk) throw new Error("unknown key id");

  return crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
}

/** Returns the token payload if everything checks out, otherwise throws. */
async function verifyIdToken(token) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed token");

  const header = b64urlToJson(parts[0]);
  const payload = b64urlToJson(parts[1]);

  if (header.alg !== "RS256") throw new Error("bad algorithm");
  if (!header.kid) throw new Error("no key id");

  const key = await getKey(header.kid);
  const signed = new TextEncoder().encode(parts[0] + "." + parts[1]);
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlToBytes(parts[2]),
    signed
  );
  if (!ok) throw new Error("bad signature");

  const now = Math.floor(Date.now() / 1000);
  const skew = 60; // allow a minute of clock drift

  if (payload.aud !== FIREBASE_PROJECT_ID) throw new Error("wrong audience");
  if (payload.iss !== "https://securetoken.google.com/" + FIREBASE_PROJECT_ID)
    throw new Error("wrong issuer");
  if (!payload.exp || payload.exp + skew < now) throw new Error("expired");
  if (!payload.iat || payload.iat - skew > now) throw new Error("issued in the future");
  if (!payload.sub) throw new Error("no subject");

  // Anonymous sign-in produces a perfectly valid token with no email, and
  // anyone can obtain one using the public API key.
  if (!payload.email) throw new Error("anonymous token rejected");

  return payload;
}

// ---------------------------------------------------------------- approval

/**
 * A valid token only proves the account exists, and anyone may register one.
 * Approval is the thing that matters, and it lives in the database, so ask
 * the database. The user's own token is forwarded, and the rules let an
 * account read its own membership row and nothing else, so no secret is
 * needed here.
 */
const approvalCache = new Map(); // uid -> { approved, checkedAt }
const APPROVAL_TTL_MS = 60 * 1000;

async function isApproved(uid, idToken) {
  const cached = approvalCache.get(uid);
  if (cached && Date.now() - cached.checkedAt < APPROVAL_TTL_MS) {
    return cached.approved;
  }
  const url =
    DB_URL + "/importReports/members/" + encodeURIComponent(uid) +
    "/approved.json?auth=" + encodeURIComponent(idToken);
  const res = await fetch(url);
  if (!res.ok) throw new Error("approval lookup failed: " + res.status);
  const approved = (await res.json()) === true;
  approvalCache.set(uid, { approved, checkedAt: Date.now() });
  return approved;
}

// ---------------------------------------------------------------- R2

/** Finds the R2 binding without needing to know what it was named. */
function findBucket(env) {
  for (const v of Object.values(env)) {
    if (v && typeof v.get === "function" && typeof v.put === "function" && typeof v.delete === "function") {
      return v;
    }
  }
  return null;
}

/**
 * Splits /upload/<key> or /file/<key> into its two parts. The key itself may
 * contain slashes, so only the first segment is treated as the route.
 */
function parsePath(pathname) {
  const raw = pathname.replace(/^\/+/, "");
  const slash = raw.indexOf("/");
  if (slash < 0) return { route: raw, key: "" };
  return {
    route: raw.slice(0, slash),
    key: decodeURIComponent(raw.slice(slash + 1)),
  };
}

// ---------------------------------------------------------------- handler

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    const bucket = findBucket(env);
    if (!bucket) {
      console.error("no R2 binding found on env");
      return json({ error: "storage unavailable" }, 500, request);
    }

    const auth = request.headers.get("Authorization") || "";
    if (!auth.startsWith("Bearer ")) {
      return json({ error: "unauthorized" }, 401, request);
    }

    const idToken = auth.slice(7).trim();
    let payload;
    try {
      payload = await verifyIdToken(idToken);
    } catch (e) {
      console.warn("token rejected:", e.message);
      return json({ error: "unauthorized" }, 401, request);
    }

    try {
      if (!(await isApproved(payload.sub, idToken))) {
        console.warn("not approved:", payload.email);
        return json({ error: "not approved" }, 403, request);
      }
    } catch (e) {
      console.error("approval check failed:", e.message);
      return json({ error: "unavailable" }, 503, request);
    }

    const { route, key } = parsePath(new URL(request.url).pathname);
    if (!key || key.includes("..")) {
      return json({ error: "bad key" }, 400, request);
    }

    try {
      if (request.method === "PUT" && route === "upload") {
        // R2 needs a known length, which a streamed body does not give it.
        const body = await request.arrayBuffer();
        await bucket.put(key, body, {
          httpMetadata: {
            contentType: request.headers.get("Content-Type") || "application/octet-stream",
          },
        });
        return json({ ok: true, key }, 200, request);
      }

      if (request.method === "GET" && route === "file") {
        const obj = await bucket.get(key);
        if (!obj) return json({ error: "not found" }, 404, request);
        return new Response(obj.body, {
          status: 200,
          headers: {
            "Content-Type": obj.httpMetadata?.contentType || "application/octet-stream",
            "Cache-Control": "private, no-store",
            ...corsHeaders(request),
          },
        });
      }

      if (request.method === "DELETE" && route === "file") {
        await bucket.delete(key);
        return json({ ok: true }, 200, request);
      }

      return json({ error: "not found" }, 404, request);
    } catch (e) {
      console.error("storage error:", e && e.message);
      return json({ error: "storage error" }, 500, request);
    }
  },
};
