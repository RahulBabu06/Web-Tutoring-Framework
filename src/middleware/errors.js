export function errorHandler(error, req, res, next) {
    if (error.type === "entity.too.large" || error.type === "parameters.too.many") {
        return res.status(413).send("That request was too large.");
    }

    console.error(error);

    if (res.headersSent) {
        return next(error);
    }

    if (error.status === 503) {
        return res.status(503).render("error", { pageTitle: "Temporarily unavailable", pageDescription: "", currentPath: req.path, status: 503, message: `${error.message} You're still signed in, so please try again in a minute.` }, (renderError, html) => {
            res.send(renderError ? error.message : html);
        });
    }

    const message = req.path.startsWith("/admin")
        ? "There was a problem loading the admin records. Check the server logs and database settings."
        : "";

    res.status(500).render("error", { pageTitle: "Something went wrong", pageDescription: "", currentPath: req.path, status: 500, message }, (renderError, html) => {
        res.send(renderError ? message || "Something went wrong." : html);
    });
}

export function sendNotFound(res, message = "") {
    res.status(404).render("error", { pageTitle: "Not found", pageDescription: "", currentPath: res.req.path, status: 404, message }, (renderError, html) => {
        res.send(renderError ? message || "Not found." : html);
    });
}
