document.querySelectorAll("[data-show-password]").forEach((toggle) => {
    const form = toggle.closest("form");

    toggle.addEventListener("change", () => {
        form.querySelectorAll("input[data-password-field]").forEach((input) => {
            input.type = toggle.checked ? "text" : "password";
        });
    });
});
