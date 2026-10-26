import express from "express";
import { loginRateLimiter, passwordResetRateLimiter, signupRateLimiter } from "../middleware/rate-limiters.js";

export function createParentAuthRouter({
    asyncHandler,
    requireParent,
    isParentAuthConfigured,
    getParentSession,
    setParentSessionCookies,
    clearParentSessionCookies,
    normalizeParentLoginInput,
    normalizeParentProfileInput,
    cleanString,
    friendlyAuthError,
    getPublicSiteOrigin,
    signInParentAccount,
    signUpParentAccount,
    sendParentPasswordReset,
    updateParentPassword,
    signOutParentAccount
}) {
    const router = express.Router();

    function renderParentAuth(res, mode, options = {}) {
        res.setHeader("Cache-Control", "no-store");
        res.status(options.status || 200).render("parent-auth", {
            mode,
            errors: options.errors || [],
            values: options.values || {},
            isParentAuthConfigured,
            registered: Boolean(options.registered),
            passwordReset: Boolean(options.passwordReset),
            emailConfirmed: Boolean(options.emailConfirmed),
            resetSent: Boolean(options.resetSent)
        });
    }

    router.get("/parents/login", asyncHandler(async (req, res) => {
        if (isParentAuthConfigured) {
            const session = await getParentSession(req, res).catch(() => null);

            if (session?.user?.id) {
                return res.redirect("/parents");
            }
        }

        renderParentAuth(res, "login", {
            registered: req.query.registered === "1",
            passwordReset: req.query.reset === "1",
            emailConfirmed: req.query.confirmed === "1"
        });
    }));

    router.post("/parents/login", loginRateLimiter, asyncHandler(async (req, res) => {
        const values = normalizeParentLoginInput(req.body);
        const errors = [];

        if (!isParentAuthConfigured) {
            errors.push("Parent accounts are not configured yet.");
        }

        if (!values.email || !values.email.includes("@")) {
            errors.push("Enter a valid email address.");
        }

        if (!values.password) {
            errors.push("Enter your password.");
        }

        if (errors.length > 0) {
            return renderParentAuth(res, "login", { status: 400, errors, values });
        }

        try {
            const session = await signInParentAccount(values);
            setParentSessionCookies(req, res, session);
            res.redirect("/parents");
        } catch (error) {
            console.error("Parent login failed:", error.message);
            renderParentAuth(res, "login", {
                status: 400,
                errors: [friendlyAuthError(error, "We could not log you in. Please check your details and try again.")],
                values
            });
        }
    }));

    router.get("/parents/register", asyncHandler(async (req, res) => {
        if (isParentAuthConfigured) {
            const session = await getParentSession(req, res).catch(() => null);

            if (session?.user?.id) {
                return res.redirect("/parents");
            }
        }

        renderParentAuth(res, "register");
    }));

    router.post("/parents/register", signupRateLimiter, asyncHandler(async (req, res) => {
        const values = normalizeParentProfileInput(req.body);
        const errors = [];

        if (!isParentAuthConfigured) {
            errors.push("Parent accounts are not configured yet.");
        }

        if (!values.fullName) {
            errors.push("Your name is required.");
        }

        if (!values.email || !values.email.includes("@")) {
            errors.push("Enter a valid email address.");
        }

        if (values.password.length < 8) {
            errors.push("Password must be at least 8 characters.");
        }

        if (values.password !== values.confirmPassword) {
            errors.push("Passwords do not match.");
        }

        if (errors.length > 0) {
            return renderParentAuth(res, "register", { status: 400, errors, values });
        }

        try {
            const authPayload = await signUpParentAccount(values, `${getPublicSiteOrigin()}/parents/login?confirmed=1`);

            if (authPayload.access_token) {
                setParentSessionCookies(req, res, authPayload);
                return res.redirect("/parents");
            }

            return res.redirect("/parents/login?registered=1");
        } catch (error) {
            console.error("Parent signup failed:", error.message);
            return renderParentAuth(res, "register", {
                status: 400,
                errors: [friendlyAuthError(error, "We could not create your account. Please try again.")],
                values
            });
        }
    }));

    router.get("/parents/forgot-password", (req, res) => {
        renderParentAuth(res, "forgot");
    });

    router.post("/parents/forgot-password", passwordResetRateLimiter, asyncHandler(async (req, res) => {
        const email = cleanString(req.body.email).toLowerCase();
        const errors = [];

        if (!isParentAuthConfigured) {
            errors.push("Parent accounts are not configured yet.");
        }

        if (!email || !email.includes("@")) {
            errors.push("Enter a valid email address.");
        }

        if (errors.length > 0) {
            return renderParentAuth(res, "forgot", { status: 400, errors, values: { email } });
        }

        try {
            await sendParentPasswordReset(email, `${getPublicSiteOrigin()}/parents/reset-password`);
        } catch (error) {
            console.error("Parent password reset request failed:", error.message);
            return renderParentAuth(res, "forgot", {
                status: 400,
                errors: ["We couldn't send a reset email right now. Please try again later."],
                values: { email }
            });
        }

        renderParentAuth(res, "forgot", { resetSent: true, values: { email } });
    }));

    router.get("/parents/reset-password", (req, res) => {
        renderParentAuth(res, "reset");
    });

    router.post("/parents/reset-password", loginRateLimiter, asyncHandler(async (req, res) => {
        const accessToken = cleanString(req.body.accessToken);
        const password = typeof req.body.password === "string" ? req.body.password : "";
        const confirmPassword = typeof req.body.confirmPassword === "string" ? req.body.confirmPassword : "";
        const errors = [];

        if (!isParentAuthConfigured) {
            errors.push("Parent accounts are not configured yet.");
        }

        if (!accessToken) {
            errors.push("This reset link is invalid or has expired. Please request a new one.");
        }

        if (password.length < 8) {
            errors.push("Password must be at least 8 characters.");
        }

        if (password !== confirmPassword) {
            errors.push("Passwords do not match.");
        }

        if (errors.length > 0) {
            return renderParentAuth(res, "reset", { status: 400, errors, values: { accessToken } });
        }

        try {
            await updateParentPassword(accessToken, password);
        } catch (error) {
            console.error("Parent password update failed:", error.message);
            return renderParentAuth(res, "reset", {
                status: 400,
                errors: ["We couldn't update your password. The reset link may have expired, so please request a new one."]
            });
        }

        clearParentSessionCookies(req, res);
        res.redirect("/parents/login?reset=1");
    }));

    router.post("/parents/logout", requireParent, asyncHandler(async (req, res) => {
        await signOutParentAccount(req.parentSession?.accessToken);
        clearParentSessionCookies(req, res);
        res.redirect("/parents/login");
    }));

    return router;
}
