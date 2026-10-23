const siteNav = document.querySelector(".site-nav");
const menuToggle = document.querySelector(".menu-toggle");

if (siteNav && menuToggle) {
    const navLinks = siteNav.querySelectorAll(".nav-links a");

    const setMenuOpen = (isOpen) => {
        siteNav.classList.toggle("nav-open", isOpen);
        menuToggle.setAttribute("aria-expanded", String(isOpen));
        menuToggle.setAttribute(
            "aria-label",
            isOpen ? "Close navigation menu" : "Open navigation menu"
        );
    };

    menuToggle.addEventListener("click", () => {
        setMenuOpen(!siteNav.classList.contains("nav-open"));
    });

    navLinks.forEach((link) => {
        link.addEventListener("click", () => setMenuOpen(false));
    });

    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
            setMenuOpen(false);
        }
    });

    const desktopQuery = window.matchMedia("(min-width: 651px)");
    const closeOnDesktop = (event) => {
        if (event.matches) {
            setMenuOpen(false);
        }
    };

    if (desktopQuery.addEventListener) {
        desktopQuery.addEventListener("change", closeOnDesktop);
    } else {
        desktopQuery.addListener(closeOnDesktop);
    }
}

const preferredClassSelect = document.querySelector("#preferredClass");
const oneToOneTimeSlotField = document.querySelector("#oneToOneTimeSlotField");
const preferredTimeSlotSelect = document.querySelector("#preferredTimeSlot");
const lessonLengthSelect = document.querySelector("#lessonLength");

if (preferredClassSelect && oneToOneTimeSlotField && preferredTimeSlotSelect) {
    const toggleTimeSlotField = () => {
        const isOneToOne = Boolean(preferredClassSelect.dataset.oneToOneOption) && preferredClassSelect.value === preferredClassSelect.dataset.oneToOneOption;

        oneToOneTimeSlotField.hidden = !isOneToOne;
        preferredTimeSlotSelect.disabled = !isOneToOne;
        preferredTimeSlotSelect.required = isOneToOne;

        if (lessonLengthSelect) {
            lessonLengthSelect.disabled = !isOneToOne;
            lessonLengthSelect.required = isOneToOne;
        }

        if (!isOneToOne) {
            preferredTimeSlotSelect.value = "";

            if (lessonLengthSelect) {
                lessonLengthSelect.value = "";
            }
        }
    };

    preferredClassSelect.addEventListener("change", toggleTimeSlotField);
    toggleTimeSlotField();
}
