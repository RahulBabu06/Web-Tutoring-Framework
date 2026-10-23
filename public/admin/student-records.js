(() => {
    const form = document.querySelector("#studentBulkForm");
    const searchInput = document.querySelector("#studentSearch");

    if (!searchInput) {
        return;
    }

    const maxSearchLength = searchInput.maxLength;

    const currentSearch = () => searchInput.value.slice(0, maxSearchLength).trim();

    const withSearch = (href) => {
        const url = new URL(href, window.location.href);
        const query = currentSearch();

        if (query) {
            url.searchParams.set("q", query);
        } else {
            url.searchParams.delete("q");
        }

        return url.pathname + url.search;
    };

    const rememberSearch = () => {
        if (form) {
            form.querySelector('input[type="hidden"][name="q"]').value = currentSearch();
        }

        document.querySelectorAll(".student-view-tabs a").forEach((link) => {
            link.setAttribute("href", withSearch(link.getAttribute("href")));
        });
        window.history.replaceState(null, "", withSearch(window.location.href));
    };

    if (!form) {
        searchInput.addEventListener("input", rememberSearch);
        return;
    }

    const rows = Array.from(form.querySelectorAll("tbody tr"));
    const selectAll = document.querySelector("#selectAllStudents");
    const count = document.querySelector("#bulkCount");
    const applyButton = document.querySelector("#bulkApply");
    const noMatches = document.querySelector("#studentNoMatches");
    const checkboxFor = (row) => row.querySelector('input[name="studentIds"]');
    const visibleRows = () => rows.filter((row) => !row.hidden);

    const updateSelection = () => {
        const shown = visibleRows();
        const ticked = shown.filter((row) => checkboxFor(row).checked).length;

        count.textContent = ticked === 0 ? "" : `${ticked} ticked`;
        applyButton.disabled = ticked === 0;
        selectAll.checked = shown.length > 0 && ticked === shown.length;
        selectAll.indeterminate = ticked > 0 && ticked < shown.length;
    };

    const filterRows = () => {
        const terms = currentSearch().toLowerCase().split(/\s+/).filter(Boolean);

        rows.forEach((row) => {
            const matches = terms.every((term) => row.dataset.search.includes(term));
            row.hidden = !matches;

            if (!matches) {
                checkboxFor(row).checked = false;
            }
        });

        noMatches.hidden = visibleRows().length > 0;
        rememberSearch();
        updateSelection();
    };

    selectAll.addEventListener("change", () => {
        visibleRows().forEach((row) => {
            checkboxFor(row).checked = selectAll.checked;
        });
        updateSelection();
    });

    form.addEventListener("change", (event) => {
        if (event.target.name === "studentIds") {
            updateSelection();
        }
    });

    form.addEventListener("submit", (event) => {
        const ticked = visibleRows().filter((row) => checkboxFor(row).checked).length;
        const action = form.querySelector("#bulkAction");
        const label = action.options[action.selectedIndex].textContent.trim();

        if (!window.confirm(`${label}: apply to ${ticked} ${ticked === 1 ? "student" : "students"}?`)) {
            event.preventDefault();
        }
    });

    searchInput.addEventListener("input", filterRows);
    filterRows();
})();
