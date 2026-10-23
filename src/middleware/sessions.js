import { adminPassword, adminSessionMs, adminSessionSecret, dataDir, isAdminLoginConfigured, parentAccessCookieName, parentRefreshCookieMs, parentRefreshCookieName } from "../config/env.js";
import crypto from "crypto";
import fs from "fs";
import { join } from "path";

const revokedAdminSessionsFile = join(dataDir, "revoked-admin-sessions.json");

export function createSessionHelpers({
    supabaseAuthRequest
}) {
    function shouldUseSecureCookies(req) {
        return req.secure || req.headers["x-forwarded-proto"] === "https";
    }

    // Lax so parents stay signed in when returning from Stripe Checkout or an email link; parent writes are all POST.
    function parentCookieOptions(req, maxAge) {
        return {
            httpOnly: true,
            maxAge,
            path: "/",
            sameSite: "lax",
            secure: shouldUseSecureCookies(req)
        };
    }

    function setParentSessionCookies(req, res, session) {
        if (!session?.access_token || !session?.refresh_token) {
            return;
        }

        res.cookie(parentAccessCookieName, session.access_token, parentCookieOptions(req, (session.expires_in || 3600) * 1000));
        res.cookie(parentRefreshCookieName, session.refresh_token, parentCookieOptions(req, parentRefreshCookieMs));
    }

    function clearParentSessionCookies(req, res) {
        res.clearCookie(parentAccessCookieName, parentCookieOptions(req, 0));
        res.clearCookie(parentRefreshCookieName, parentCookieOptions(req, 0));
    }

    async function getParentSession(req, res) {
        const cookies = parseCookies(req);
        const accessToken = cookies[parentAccessCookieName];
        const refreshToken = cookies[parentRefreshCookieName];

        if (!accessToken && !refreshToken) {
            return null;
        }

        if (accessToken) {
            try {
                const user = await supabaseAuthRequest("/user", { accessToken });
                return { user, accessToken, refreshToken };
            } catch (error) {
                if (!refreshToken) {
                    clearParentSessionCookies(req, res);
                    return null;
                }
            }
        }

        if (!refreshToken) {
            clearParentSessionCookies(req, res);
            return null;
        }

        try {
            const refreshedSession = await supabaseAuthRequest("/token?grant_type=refresh_token", {
                method: "POST",
                body: JSON.stringify({ refresh_token: refreshToken })
            });
            setParentSessionCookies(req, res, refreshedSession);
            return {
                user: refreshedSession.user,
                accessToken: refreshedSession.access_token,
                refreshToken: refreshedSession.refresh_token
            };
        } catch (error) {
            clearParentSessionCookies(req, res);
            return null;
        }
    }

    function parseCookies(req) {
        return Object.fromEntries((req.headers.cookie || "").split(";").filter(Boolean).map((cookie) => {
            const [key, ...value] = cookie.trim().split("=");
            try {
                return [key, decodeURIComponent(value.join("="))];
            } catch {
                return [key, ""];
            }
        }));
    }

    function isAdminPasswordCorrect(password) {
        if (!isAdminLoginConfigured || typeof password !== "string") {
            return false;
        }

        const provided = crypto.createHash("sha256").update(password).digest();
        const expected = crypto.createHash("sha256").update(adminPassword).digest();
        return crypto.timingSafeEqual(provided, expected);
    }

    function adminCookieOptions(req, maxAge) {
        return {
            httpOnly: true,
            maxAge,
            path: "/",
            sameSite: "strict",
            secure: shouldUseSecureCookies(req)
        };
    }

    // Session ids revoked by logout, kept until their token would have expired anyway.
    // Saved to disk so a logged-out cookie stays logged out after a restart.
    const revokedAdminSessions = loadRevokedAdminSessions();

    function loadRevokedAdminSessions() {
        try {
            const entries = JSON.parse(fs.readFileSync(revokedAdminSessionsFile, "utf8"));
            return new Map(Object.entries(entries).filter(([, exp]) => Number(exp) > Date.now()));
        } catch (error) {
            if (error.code !== "ENOENT") {
                console.error("Could not read revoked admin sessions:", error.message);
            }
            return new Map();
        }
    }

    function saveRevokedAdminSessions() {
        try {
            fs.mkdirSync(dataDir, { recursive: true });
            fs.writeFileSync(revokedAdminSessionsFile, JSON.stringify(Object.fromEntries(revokedAdminSessions)), { mode: 0o600 });
        } catch (error) {
            console.error("Could not save revoked admin sessions:", error.message);
        }
    }

    function pruneRevokedAdminSessions() {
        const now = Date.now();

        for (const [sid, exp] of revokedAdminSessions) {
            if (exp <= now) {
                revokedAdminSessions.delete(sid);
            }
        }
    }

    function createAdminToken() {
        const payload = Buffer.from(JSON.stringify({
            sid: crypto.randomBytes(16).toString("base64url"),
            exp: Date.now() + adminSessionMs
        })).toString("base64url");
        const signature = crypto.createHmac("sha256", adminSessionSecret).update(payload).digest("base64url");
        return `${payload}.${signature}`;
    }

    function readAdminToken(token) {
        if (!isAdminLoginConfigured || typeof token !== "string" || !token.includes(".")) {
            return null;
        }

        const [payload, signature] = token.split(".");
        const expectedSignature = crypto.createHmac("sha256", adminSessionSecret).update(payload).digest("base64url");
        const provided = Buffer.from(signature);
        const expected = Buffer.from(expectedSignature);

        if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
            return null;
        }

        try {
            const decodedPayload = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
            const exp = Number(decodedPayload.exp);
            const sid = decodedPayload.sid;

            if (typeof sid !== "string" || !sid || !(exp > Date.now()) || revokedAdminSessions.has(sid)) {
                return null;
            }

            return { sid, exp };
        } catch (error) {
            return null;
        }
    }

    function isValidAdminToken(token) {
        return Boolean(readAdminToken(token));
    }

    function revokeAdminToken(token) {
        const session = readAdminToken(token);

        if (session) {
            pruneRevokedAdminSessions();
            revokedAdminSessions.set(session.sid, session.exp);
            saveRevokedAdminSessions();
        }
    }

    return {
        shouldUseSecureCookies,
        parentCookieOptions,
        setParentSessionCookies,
        clearParentSessionCookies,
        getParentSession,
        parseCookies,
        isAdminPasswordCorrect,
        adminCookieOptions,
        revokedAdminSessions,
        pruneRevokedAdminSessions,
        createAdminToken,
        readAdminToken,
        isValidAdminToken,
        revokeAdminToken
    };
}
