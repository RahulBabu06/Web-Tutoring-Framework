import express from "express";
import { backupImportBodyParser } from "../middleware/security.js";
import { backupImportRateLimiter } from "../middleware/rate-limiters.js";
import { backupsDir, business } from "../config/env.js";
import fs from "fs";
import { join } from "path";

export function createAdminBackupsRouter({
    BackupImportError,
    adminSchemaNames,
    asyncHandler,
    backupPayload,
    cleanString,
    ensureBackupDirectory,
    importBackupStudents,
    isMissingAdminSchema,
    isSupabaseConfigured,
    requireAdmin,
    setupIncompleteMessage
}) {
    const router = express.Router();

    router.get("/admin/backup/download", requireAdmin, asyncHandler(async (req, res) => {
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Content-Disposition", `attachment; filename="${business.slug}-backup-${timestamp}.json"`);
        res.send(JSON.stringify(await backupPayload(), null, 2));
    }));

    router.post("/admin/backup/save", requireAdmin, asyncHandler(async (req, res) => {
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const filename = `${business.slug}-backup-${timestamp}.json`;
        const backupPath = join(backupsDir, filename);

        ensureBackupDirectory();
        fs.writeFileSync(backupPath, JSON.stringify(await backupPayload(), null, 2));
        res.redirect(`/admin/backup?saved=${encodeURIComponent(filename)}`);
    }));

    function renderBackupImport(res, options = {}) {
        res.status(options.status || 200).render("admin-backup-import", {
            errors: options.errors || [],
            result: options.result || null,
            removals: options.removals || null,
            backupJson: options.backupJson || "",
            savedBackup: options.savedBackup || "",
            isSupabaseConfigured
        });
    }

    router.get("/admin/backup", requireAdmin, (req, res) => {
        renderBackupImport(res, { savedBackup: cleanString(req.query.saved) });
    });

    router.get("/admin/backup/import", requireAdmin, (req, res) => {
        res.redirect("/admin/backup");
    });

    router.post("/admin/backup/import", requireAdmin, backupImportRateLimiter, backupImportBodyParser, asyncHandler(async (req, res) => {
        const errors = [];
        let backup = null;

        if (!isSupabaseConfigured) {
            errors.push("Database service is not configured yet.");
        }

        if (!cleanString(req.body.backupJson)) {
            errors.push("Choose a backup file or paste backup JSON before importing.");
        }

        if (errors.length === 0) {
            try {
                backup = JSON.parse(req.body.backupJson);
            } catch (error) {
                errors.push("That backup is not valid JSON.");
            }
        }

        if (errors.length > 0) {
            return renderBackupImport(res, { status: 400, errors });
        }

        const replaceExisting = req.body.replaceExisting === "1";

        try {
            const result = await importBackupStudents(backup, {
                replaceExisting,
                allowRemovals: replaceExisting && req.body.confirmRemovals === "1"
            });

            if (result.needsConfirmation) {
                return renderBackupImport(res, { status: 409, removals: result.removed, backupJson: req.body.backupJson });
            }

            return renderBackupImport(res, { result });
        } catch (error) {
            console.error("Backup import failed:", error.message);
            const message = error instanceof BackupImportError
                ? error.message
                : isMissingAdminSchema(error, [...adminSchemaNames, "import_admin_backup"])
                    ? setupIncompleteMessage
                    : "There was a problem importing that backup. Nothing was changed. Check the server logs for details.";

            return renderBackupImport(res, { status: 400, errors: [message] });
        }
    }));

    return router;
}
