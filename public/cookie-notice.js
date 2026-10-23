(function () {
    var storageKey = "cookie-notice";

    try {
        if (window.localStorage.getItem(storageKey) === "dismissed") {
            return;
        }
    } catch (error) {
        // Storage blocked: show the notice each visit.
    }

    var notice = document.createElement("div");
    notice.className = "cookie-notice";
    notice.setAttribute("role", "region");
    notice.setAttribute("aria-label", "Cookie notice");

    var text = document.createElement("p");
    text.textContent = "We only use essential cookies. ";

    var link = document.createElement("a");
    link.href = "/cookies";
    link.textContent = "Cookie policy";
    text.appendChild(link);

    var button = document.createElement("button");
    button.type = "button";
    button.textContent = "OK";
    button.addEventListener("click", function () {
        try {
            window.localStorage.setItem(storageKey, "dismissed");
        } catch (error) {
            // Ignore: the notice simply shows again next time.
        }
        notice.remove();
    });

    notice.appendChild(text);
    notice.appendChild(button);
    document.body.appendChild(notice);
})();
