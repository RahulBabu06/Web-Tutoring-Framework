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

const registerForm = document.querySelector(".register-form");
const registerRows = [...document.querySelectorAll(".register-table tbody tr")];
const registerStatus = document.querySelector("[data-register-status]");
let hasUnsavedChanges = false;

function updateRegisterStatus() {
    if (!registerStatus) {
        return;
    }

    const marked = registerRows.filter((row) => row.querySelector(".attendance-toggle input:checked")).length;
    const unmarked = registerRows.length - marked;
    registerStatus.textContent = `${marked} of ${registerRows.length} marked`
        + (unmarked > 0 ? `. ${unmarked} unmarked will not be saved or charged.` : ".")
        + (hasUnsavedChanges ? " Unsaved changes." : "");
}

function markChanged() {
    hasUnsavedChanges = true;
    updateRegisterStatus();
}

document.querySelectorAll("[data-mark-all-present]").forEach((button) => {
    button.addEventListener("click", () => {
        registerRows.forEach((row) => {
            if (!row.querySelector(".attendance-toggle input:checked")) {
                row.querySelector(".attendance-toggle input[value='present']").checked = true;
                row.querySelector(".credit-delta-input").value = "-1";
                updateRegisterRow(row);
            }
        });
        markChanged();
    });
});

if (registerForm) {
    registerForm.addEventListener("input", markChanged);
    registerForm.addEventListener("submit", () => {
        hasUnsavedChanges = false;
    });
    window.addEventListener("beforeunload", (event) => {
        if (hasUnsavedChanges) {
            event.preventDefault();
            event.returnValue = "";
        }
    });
    updateRegisterStatus();
}

registerRows.forEach((row) => {
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
