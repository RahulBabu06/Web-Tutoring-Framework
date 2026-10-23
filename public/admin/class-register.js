document.querySelectorAll("[data-print-page]").forEach((button) => {
    button.addEventListener("click", () => window.print());
});

function updateRegisterRow(row) {
    const checked = row.querySelector(".attendance-toggle input[type='radio']:checked");
    const creditInput = row.querySelector(".credit-delta-input");
    const waiveLabel = row.querySelector("[data-waive-label]");
    const waiveBox = waiveLabel ? waiveLabel.querySelector("input") : null;
    const isAbsent = checked && checked.value === "absent";

    if (waiveLabel) {
        waiveLabel.hidden = !isAbsent;
    }

    creditInput.readOnly = isAbsent;

    if (isAbsent) {
        const isFree = Number(row.dataset.freeSkipsLeft) > 0 || (waiveBox && waiveBox.checked);
        creditInput.value = isFree ? "0" : "-1";
    }
}

document.querySelectorAll(".register-table tbody tr").forEach((row) => {
    row.querySelectorAll(".attendance-toggle input[type='radio']").forEach((radio) => {
        radio.addEventListener("change", () => {
            if (radio.value === "present") {
                row.querySelector(".credit-delta-input").value = "-1";
            }

            updateRegisterRow(row);
        });
    });

    const waiveBox = row.querySelector("[data-waive-label] input");

    if (waiveBox) {
        waiveBox.addEventListener("change", () => updateRegisterRow(row));
    }
});
