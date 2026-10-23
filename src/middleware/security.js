import bodyParser from "body-parser";
import helmet from "helmet";

export const securityHeaders = helmet({
    contentSecurityPolicy: {
        directives: {
            upgradeInsecureRequests: null,
            formAction: ["'self'", "https://checkout.stripe.com"]
        }
    }
});

const csrfSafeMethods = new Set(["GET", "HEAD", "OPTIONS"]);

function originHost(value) {
    try {
        return new URL(value).host;
    } catch {
        return null;
    }
}

// Blocks cross-site form posts (CSRF, including login CSRF). Browsers always send Sec-Fetch-Site or Origin on POSTs.
function isSameOriginRequest(req) {
    const fetchSite = req.get("sec-fetch-site");
    if (fetchSite) {
        return fetchSite === "same-origin" || fetchSite === "none";
    }

    const origin = req.get("origin");
    if (!origin) {
        return true;
    }

    const host = originHost(origin);
    return Boolean(host) && (
        host === req.get("host") ||
        (Boolean(process.env.SITE_URL) && host === originHost(process.env.SITE_URL))
    );
}

export function csrfProtection(req, res, next) {
    if (csrfSafeMethods.has(req.method) || req.path === "/stripe/webhook" || isSameOriginRequest(req)) {
        return next();
    }

    res.status(403).send("This form must be submitted from this website.");
}

const backupImportPath = /^\/admin\/backup\/import\/?$/i;
export const backupImportBodyParser = bodyParser.urlencoded({ extended: false, limit: "10mb", parameterLimit: 10 });
const defaultBodyParser = bodyParser.urlencoded({ extended: true, limit: "100kb" });

// The backup import parses its large body itself, after requireAdmin.
export function formBodyParser(req, res, next) {
    if (req.method === "POST" && backupImportPath.test(req.path)) {
        return next();
    }

    return defaultBodyParser(req, res, next);
}
