import nodemailer from "nodemailer";

export function createGmailClient({ senderAddress, oauth }) {
    const isConfigured = Boolean(oauth.clientId && oauth.clientSecret && oauth.refreshToken);
    // Nodemailer only builds the MIME message; it is sent through the Gmail API.
    const mailComposer = nodemailer.createTransport({ streamTransport: true, buffer: true });
    let accessToken = { value: "", expiresAt: 0 };

    if (!isConfigured) {
        console.warn("Gmail API credentials (GMAIL_OAUTH_*) are not set; emails will not be sent.");
    }

    async function getAccessToken() {
        if (accessToken.value && Date.now() < accessToken.expiresAt - 60 * 1000) {
            return accessToken.value;
        }

        const response = await fetch("https://oauth2.googleapis.com/token", {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded"
            },
            body: new URLSearchParams({
                client_id: oauth.clientId,
                client_secret: oauth.clientSecret,
                refresh_token: oauth.refreshToken,
                grant_type: "refresh_token"
            })
        });
        const data = await response.json().catch(() => ({}));

        if (!response.ok || !data.access_token) {
            throw new Error(`Gmail token refresh failed (${response.status}): ${data.error || "unknown error"}`);
        }

        accessToken = {
            value: data.access_token,
            expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000
        };
        return accessToken.value;
    }

    async function sendEmail(message) {
        if (!isConfigured) {
            throw new Error("Gmail API credentials are not set.");
        }

        const composed = await mailComposer.sendMail({ from: senderAddress, ...message });
        const token = await getAccessToken();
        const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ raw: composed.message.toString("base64url") })
        });

        if (!response.ok) {
            if (response.status === 401) {
                accessToken = { value: "", expiresAt: 0 };
            }

            const data = await response.json().catch(() => ({}));
            throw new Error(`Gmail send failed (${response.status}): ${data.error?.message || "unknown error"}`);
        }
    }

    return { isConfigured, sendEmail };
}
