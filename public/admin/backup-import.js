const importForm = document.getElementById("backupImportForm");
const fileInput = document.getElementById("backupFile");
const jsonInput = document.getElementById("backupJson");

if (importForm && fileInput && jsonInput) {
    importForm.addEventListener("submit", async (event) => {
        if (jsonInput.value.trim() || fileInput.files.length === 0) {
            return;
        }

        event.preventDefault();
        jsonInput.value = await fileInput.files[0].text();
        importForm.requestSubmit();
    });
}
