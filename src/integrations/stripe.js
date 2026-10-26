import crypto from "crypto";

const requestTimeoutMs = 20 * 1000;

export function createStripeClient({ secretKey, webhookSecret }) {
    async function request(path, { method = "GET", params } = {}) {
        const response = await fetch(`https://api.stripe.com/v1${path}`, {
            method,
            headers: {
                Authorization: `Bearer ${secretKey}`,
                ...(params ? { "Content-Type": "application/x-www-form-urlencoded" } : {})
            },
            body: params ? new URLSearchParams(params) : undefined,
            signal: AbortSignal.timeout(requestTimeoutMs)
        });
        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
            throw new Error(`Stripe request failed (${response.status}): ${data.error?.message || "unknown error"}`);
        }

        return data;
    }

    function verifySignature(rawBody, header) {
        const items = String(header || "").split(",").map((item) => item.split("="));
        const timestamp = items.find(([key]) => key === "t")?.[1];
        const signatures = items.filter(([key]) => key === "v1").map(([, value]) => value || "");

        if (!timestamp || signatures.length === 0 || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) {
            return false;
        }

        const expected = crypto.createHmac("sha256", webhookSecret).update(`${timestamp}.`).update(rawBody).digest("hex");
        return signatures.some((signature) => signature.length === expected.length
            && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected)));
    }

    return { isConfigured: Boolean(secretKey), request, verifySignature };
}
