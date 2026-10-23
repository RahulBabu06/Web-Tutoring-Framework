export function createAuthMiddleware({ isAdminRequest, loadAdminPendingCounts, setAdminNavLinks, getParentSession }) {
    function requireAdmin(req, res, next) {
        if (!isAdminRequest(req)) {
            return res.redirect("/admin/login");
        }

        res.setHeader("Cache-Control", "no-store");
        const path = req.baseUrl + req.path;
        setAdminNavLinks(res, path);

        if (req.method !== "GET") {
            return next();
        }

        loadAdminPendingCounts()
            .then((counts) => {
                res.locals.adminPendingCounts = counts;
                setAdminNavLinks(res, path, counts);
            }, () => {})
            .then(() => next());
    }

    function requireParent(req, res, next) {
        getParentSession(req, res)
            .then((session) => {
                if (!session?.user?.id) {
                    return res.redirect("/parents/login");
                }

                req.parentSession = session;
                req.parentUser = session.user;
                res.setHeader("Cache-Control", "no-store");
                next();
            })
            .catch(next);
    }

    return { requireAdmin, requireParent };
}
