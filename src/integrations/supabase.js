export function inFilter(values) {
    return `in.(${values.map(encodeURIComponent).join(",")})`;
}

// For free-text values: PostgREST needs values containing , . : ( ) quoted inside in.().
export function quotedInFilter(values) {
    return inFilter(values.map((value) => `"${String(value).replace(/["\\]/g, "\\$&")}"`));
}

function parsePayload(responseText) {
    try {
        return responseText ? JSON.parse(responseText) : null;
    } catch (error) {
        return responseText;
    }
}

export function createSupabaseClient({ url, adminKey, anonKey, timeoutMs, pageSize }) {
    const isConfigured = Boolean(url && adminKey);
    const isAuthConfigured = Boolean(url && anonKey && adminKey);

    async function request(path, options = {}) {
        if (!isConfigured) {
            throw new Error("Database service is not configured.");
        }

        const { withCount, ...fetchOptions } = options;
        const headers = {
            apikey: adminKey,
            Accept: "application/json",
            ...(adminKey.startsWith("sb_secret_") ? {} : { Authorization: `Bearer ${adminKey}` }),
            ...(options.body ? { "Content-Type": "application/json" } : {}),
            ...(withCount ? { Prefer: "count=exact" } : {}),
            ...(options.headers || {})
        };

        const response = await fetch(`${url}/rest/v1${path}`, {
            ...options,
            headers,
            signal: options.signal || AbortSignal.timeout(timeoutMs)
        });
        const responseText = await response.text();
        const payload = parsePayload(responseText);

        if (!response.ok) {
            const message = payload?.message || responseText || response.statusText;
            const error = new Error(`Database request failed (${response.status}): ${message}`);
            error.code = payload?.code;
            throw error;
        }

        if (withCount) {
            const total = Number((response.headers.get("content-range") || "").split("/")[1]);
            return { rows: payload, total: Number.isInteger(total) ? total : null };
        }

        return payload;
    }

    // PostgREST caps each response at max-rows (1000 on Supabase), so read whole tables (or a filtered
    // slice) page by page and check the result against the exact row count.
    async function listAllRows(table, order, filter = "") {
        const rowsById = new Map();
        const orderBy = [order, "id.asc"].filter(Boolean).join(",");
        let offset = 0;
        let total = 0;

        do {
            const page = await request(`/${table}?select=*${filter ? `&${filter}` : ""}&order=${orderBy}&limit=${pageSize}&offset=${offset}`, { withCount: true });

            if (page.total === null) {
                throw new Error(`Could not count the rows in ${table}.`);
            }

            total = page.total;

            if (page.rows.length === 0) {
                break;
            }

            page.rows.forEach((row) => rowsById.set(row.id, row));
            offset += page.rows.length;
        } while (offset < total);

        if (rowsById.size !== total) {
            throw new Error(`${table} changed while it was being read (${rowsById.size} of ${total} rows). Try again.`);
        }

        return [...rowsById.values()];
    }

    async function getRowById(table, id, toView) {
        const rows = await request(`/${table}?id=eq.${encodeURIComponent(id)}&select=*&limit=1`);
        return rows[0] ? toView(rows[0]) : null;
    }

    async function authRequest(path, options = {}) {
        if (!isAuthConfigured) {
            throw new Error("Parent accounts are not configured.");
        }

        const headers = {
            apikey: anonKey,
            Authorization: `Bearer ${options.accessToken || anonKey}`,
            Accept: "application/json",
            ...(options.body ? { "Content-Type": "application/json" } : {}),
            ...(options.headers || {})
        };

        const response = await fetch(`${url}/auth/v1${path}`, {
            method: options.method || "GET",
            body: options.body,
            headers,
            signal: options.signal || AbortSignal.timeout(timeoutMs)
        });
        const responseText = await response.text();
        const payload = parsePayload(responseText);

        if (!response.ok) {
            const message = payload?.msg || payload?.message || payload?.error_description || payload?.error || responseText || response.statusText;
            throw new Error(`Account service request failed (${response.status}): ${message}`);
        }

        return payload;
    }

    return { isConfigured, isAuthConfigured, request, listAllRows, getRowById, authRequest };
}
