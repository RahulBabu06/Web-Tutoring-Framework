import { BlockList, isIP } from "net";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";

// Published at https://www.cloudflare.com/ips/
const cloudflareIpRanges = [
    "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22",
    "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20",
    "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
    "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
    "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32",
    "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32"
];
const cloudflareIps = new BlockList();
for (const range of cloudflareIpRanges) {
    const [network, prefix] = range.split("/");
    cloudflareIps.addSubnet(network, Number(prefix), isIP(network) === 6 ? "ipv6" : "ipv4");
}

function isCloudflareIp(ip) {
    const address = String(ip || "").replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, "");
    const family = isIP(address);
    return family !== 0 && cloudflareIps.check(address, family === 6 ? "ipv6" : "ipv4");
}

// Render sits behind Cloudflare, so req.ip can be a Cloudflare edge address that changes per request.
// CF-Connecting-IP is only trusted when the request really arrived from a Cloudflare edge; otherwise
// anyone reaching the origin directly could pick a fresh rate-limit key for every request.
export function getClientIp(req) {
    const cloudflareClientIp = req.get("cf-connecting-ip")?.trim();
    if (cloudflareClientIp && isIP(cloudflareClientIp) && isCloudflareIp(req.ip)) {
        return cloudflareClientIp;
    }
    return req.ip;
}

function createRateLimiter(windowMs, limit, message, keyGenerator) {
    return rateLimit({
        windowMs,
        limit,
        standardHeaders: "draft-8",
        legacyHeaders: false,
        keyGenerator: keyGenerator || ((req) => ipKeyGenerator(getClientIp(req))),
        handler: (req, res) => {
            res.status(429).render("error", { pageTitle: "Too many requests", pageDescription: "", currentPath: req.path, status: 429, message }, (renderError, html) => {
                res.send(renderError ? message : html);
            });
        }
    });
}

export const loginRateLimiter = createRateLimiter(
    15 * 60 * 1000,
    10,
    "Too many login attempts. Please wait 15 minutes and try again."
);
export const signupRateLimiter = createRateLimiter(
    60 * 60 * 1000,
    5,
    "Too many sign-up attempts. Please wait an hour and try again."
);
export const passwordResetRateLimiter = createRateLimiter(
    60 * 60 * 1000,
    5,
    "Too many password reset requests. Please wait an hour and try again."
);
export const bookingRateLimiter = createRateLimiter(
    60 * 60 * 1000,
    5,
    "Too many booking requests. Please wait an hour and try again, or contact us directly."
);
export const refundRequestRateLimiter = createRateLimiter(
    60 * 60 * 1000,
    5,
    "Too many refund requests. Please wait an hour and try again, or contact us directly."
);
export const backupImportRateLimiter = createRateLimiter(
    15 * 60 * 1000,
    20,
    "Too many backup imports. Please wait 15 minutes and try again."
);

export const checkoutRateLimiter = createRateLimiter(
    15 * 60 * 1000,
    20,
    "Too many payment attempts. Please wait a few minutes and try again."
);

// Mount after requireParent: keyed on the signed-in parent so one account can't flood the admin queue.
export const childLinkRequestRateLimiter = createRateLimiter(
    60 * 60 * 1000,
    5,
    "Too many child link requests. Please wait an hour and try again, or contact us directly.",
    (req) => `parent:${req.parentUser.id}`
);

