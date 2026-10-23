// One-off helper: run on your own computer to get a Gmail API refresh token.
// Usage: GMAIL_OAUTH_CLIENT_ID=... GMAIL_OAUTH_CLIENT_SECRET=... npm run gmail:auth
import crypto from "node:crypto";
import http from "node:http";

const clientId = process.env.GMAIL_OAUTH_CLIENT_ID;
const clientSecret = process.env.GMAIL_OAUTH_CLIENT_SECRET;

if (!clientId || !clientSecret) {
    console.error("Set GMAIL_OAUTH_CLIENT_ID and GMAIL_OAUTH_CLIENT_SECRET first (from a Google Cloud \"Desktop app\" OAuth client).");
    process.exit(1);
}

const state = crypto.randomBytes(16).toString("hex");
let redirectUri = "";

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, redirectUri);

    if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
    }

    if (url.searchParams.get("state") !== state || !url.searchParams.get("code")) {
        res.writeHead(400).end("Sign-in failed or was cancelled. Run the script again.");
        console.error("Sign-in failed:", url.searchParams.get("error") || "missing code");
        server.close();
        return;
    }

    const response = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            code: url.searchParams.get("code"),
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: redirectUri,
            grant_type: "authorization_code"
        })
    });
    const data = await response.json();

    if (!response.ok || !data.refresh_token) {
        res.writeHead(500).end("Could not get a refresh token. Check the terminal.");
        console.error("Token exchange failed:", data.error_description || data.error || response.status);
    } else {
        res.end("Done. You can close this tab and go back to the terminal.");
        console.log("\nSet this on your host (or in .env) as GMAIL_OAUTH_REFRESH_TOKEN (keep it secret):\n");
        console.log(data.refresh_token);
    }

    server.close();
});

server.listen(0, "127.0.0.1", () => {
    redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
    const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authUrl.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "https://www.googleapis.com/auth/gmail.send",
        access_type: "offline",
        prompt: "consent",
        state
    }).toString();
    console.log("Open this link and sign in with the Gmail account the site sends from:\n");
    console.log(authUrl.toString());
});
