import assert from "node:assert/strict";
import test from "node:test";
import { createSessionHelpers } from "../src/middleware/sessions.js";

function fakeRequestResponse() {
    const cleared = [];
    const req = { headers: { cookie: "tutoring_parent_access=old-access; tutoring_parent_refresh=old-refresh" }, secure: false };
    const res = { clearCookie: (name) => cleared.push(name), cookie: () => {} };
    return { req, res, cleared };
}

function failingAuth(status) {
    return async () => {
        const error = new Error(`Account service request failed (${status})`);
        error.status = status;
        throw error;
    };
}

test("a temporary Auth outage keeps the parent signed in", async () => {
    const { getParentSession } = createSessionHelpers({ supabaseAuthRequest: failingAuth(503) });
    const { req, res, cleared } = fakeRequestResponse();

    await assert.rejects(getParentSession(req, res), { status: 503 });
    assert.deepEqual(cleared, []);
});

test("rejected parent tokens sign the parent out", async () => {
    const { getParentSession } = createSessionHelpers({ supabaseAuthRequest: failingAuth(401) });
    const { req, res, cleared } = fakeRequestResponse();

    assert.equal(await getParentSession(req, res), null);
    assert.equal(cleared.length, 2);
});
