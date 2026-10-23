const tokenInput = document.getElementById("accessToken");
const linkError = document.querySelector("[data-reset-link-error]");

if (tokenInput) {
    const params = new URLSearchParams(window.location.hash.slice(1));

    if (params.get("access_token")) {
        tokenInput.value = params.get("access_token");
    }

    if (window.location.hash) {
        history.replaceState(null, "", window.location.pathname + window.location.search);
    }

    if (!tokenInput.value && linkError) {
        linkError.hidden = false;
    }
}
