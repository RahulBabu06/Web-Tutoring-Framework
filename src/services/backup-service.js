import { AttendanceStatus, PaymentStatus, StudentStatus, classOptions, groupClasses, paymentStatuses } from "../config/classes.js";
import { backupsDir, business } from "../config/env.js";
import fs from "fs";

export function createBackupService({
    attendanceChargeTypes,
    cleanDisplayNotes,
    cleanString,
    isDateInput,
    isUuid,
    listAllRows,
    normalizeAttendanceStatus,
    normalizeClassDate,
    supabaseRequest,
    toAttendanceView,
    toInteger,
    toPaymentView,
    toStudentRow,
    toStudentView
}) {
    class BackupImportError extends Error {}

    function ensureBackupDirectory() {
        if (!fs.existsSync(backupsDir)) {
            fs.mkdirSync(backupsDir, { recursive: true });
        }
    }

    function extractBackupData(backup) {
        const data = backup?.data || backup;
        const students = Array.isArray(data?.students) ? data.students : Array.isArray(backup) ? backup : [];
        const batches = Array.isArray(data?.batches) ? data.batches : Array.isArray(backup?.batches) ? backup.batches : [];

        if (students.length === 0) {
            throw new Error("The backup does not contain any students.");
        }

        return { students, batches };
    }

    function toImportedStudentRow(student, batchesById) {
        const name = cleanString(student.name || student.studentName || student.childName);

        if (!name) {
            return null;
        }

        const importedEmail = cleanString(student.parentEmail || student.parent_email || student.email);
        const batchName = cleanString(batchesById.get(String(student.batchId)));
        const oldId = String(student.id || "").trim();
        const preferredClass = [
            cleanString(student.preferredClass || student.preferred_class),
            groupClasses.find((groupClass) => [groupClass.id, groupClass.day, groupClass.name.toLowerCase()].includes(batchName.toLowerCase()))?.option || ""
        ].find((candidate) => classOptions.includes(candidate)) || "";
        const status = cleanString(student.status).toLowerCase() === StudentStatus.inactive || batchName.toLowerCase() === "discard" ? StudentStatus.inactive : StudentStatus.active;
        const row = toStudentRow({
            name,
            parentName: cleanString(student.parentName || student.parent_name) || (!importedEmail.includes("@") ? importedEmail : ""),
            parentEmail: importedEmail.includes("@") ? importedEmail : "",
            phone: cleanString(student.phone),
            preferredClass,
            credits: toInteger(student.credits),
            status,
            notes: cleanDisplayNotes(student.notes)
        });

        if (isUuid(oldId)) {
            row.id = oldId;
        }

        return row;
    }

    async function listAllAttendance() {
        const rows = await listAllRows("admin_attendance", "class_date.desc");
        return rows.map(toAttendanceView);
    }

    async function listAllPayments() {
        const rows = await listAllRows("admin_payments", "paid_at.desc,created_at.desc");
        return rows.map(toPaymentView);
    }

    function checkBackupCounts(backupData, lists) {
        const counts = backupData?.counts;

        if (!counts || typeof counts !== "object") {
            return;
        }

        const short = Object.entries(lists)
            .filter(([name, list]) => Number.isInteger(counts[name]) && list.length !== counts[name])
            .map(([name, list]) => `${list.length} of ${counts[name]} ${name} records`);

        if (short.length > 0) {
            throw new BackupImportError(`This backup file is incomplete: it has ${short.join(", ")}. Nothing was imported.`);
        }
    }

    async function importBackupStudents(backup, { replaceExisting = false, allowRemovals = false } = {}) {
        const { students, batches } = extractBackupData(backup);
        const backupData = backup?.data || backup;
        const attendance = Array.isArray(backupData?.attendance) ? backupData.attendance : [];
        const payments = Array.isArray(backupData?.payments) ? backupData.payments : [];
        const batchesById = new Map(batches.map((batch) => [String(batch.id), batch.name]));
        const rows = students.map((student) => toImportedStudentRow(student, batchesById)).filter(Boolean);
        const skipped = students.length - rows.length;

        if (rows.length === 0) {
            throw new Error("No importable students were found in the backup.");
        }

        checkBackupCounts(backupData, { students, attendance, payments });

        const attendanceRows = attendance.map((record) => {
            if (!isUuid(record.studentId || record.student_id) || !isDateInput(record.classDate || record.class_date)) {
                return null;
            }

            const status = normalizeAttendanceStatus(record.status);
            return {
                student_id: record.studentId || record.student_id,
                class_date: normalizeClassDate(record.classDate || record.class_date),
                status,
                credit_delta: toInteger(record.creditDelta ?? record.credit_delta, status === AttendanceStatus.present ? -1 : 0),
                charge_type: attendanceChargeTypes.includes(record.chargeType ?? record.charge_type) ? (record.chargeType ?? record.charge_type) : null,
                notes: cleanString(record.notes) || null
            };
        }).filter(Boolean);

        const paymentRows = payments.map((payment) => {
            const studentId = payment.studentId || payment.student_id;

            if (!isUuid(studentId)) {
                return null;
            }

            return {
                ...(isUuid(payment.id) ? { id: payment.id } : {}),
                student_id: studentId,
                amount_pence: toInteger(payment.amountPence ?? payment.amount_pence),
                currency: cleanString(payment.currency || business.currency).toUpperCase(),
                status: paymentStatuses.includes(payment.status) ? payment.status : PaymentStatus.paid,
                provider: cleanString(payment.provider) || "manual",
                payment_method: cleanString(payment.paymentMethod || payment.payment_method) || "manual",
                provider_payment_id: cleanString(payment.providerPaymentId || payment.provider_payment_id) || null,
                provider_checkout_session_id: cleanString(payment.providerCheckoutSessionId || payment.provider_checkout_session_id) || null,
                credits_purchased: toInteger(payment.creditsPurchased ?? payment.credits_purchased),
                paid_at: payment.paidAt || payment.paid_at || null,
                notes: cleanString(payment.notes) || null
            };
        }).filter(Boolean);

        const result = await supabaseRequest("/rpc/import_admin_backup", {
            method: "POST",
            body: JSON.stringify({
                p_students: rows,
                p_attendance: attendanceRows,
                p_payments: paymentRows,
                p_replace: replaceExisting,
                p_allow_removals: allowRemovals
            })
        });
        const removed = {
            students: toInteger(result?.removed_students),
            attendance: toInteger(result?.removed_attendance),
            payments: toInteger(result?.removed_payments)
        };

        return {
            needsConfirmation: result?.status === "confirmation_required",
            imported: toInteger(result?.imported_students),
            skipped,
            attendanceImported: toInteger(result?.imported_attendance),
            paymentsImported: toInteger(result?.imported_payments),
            removed,
            replaced: replaceExisting
        };
    }

    async function backupPayload() {
        const students = (await listAllRows("admin_students", "name.asc")).map(toStudentView);
        const attendance = await listAllAttendance();
        const payments = await listAllPayments();

        return {
            exportedAt: new Date().toISOString(),
            source: "database",
            data: {
                version: 1,
                students,
                attendance,
                payments,
                counts: {
                    students: students.length,
                    attendance: attendance.length,
                    payments: payments.length
                }
            }
        };
    }

    return {
        BackupImportError,
        ensureBackupDirectory,
        extractBackupData,
        toImportedStudentRow,
        listAllAttendance,
        listAllPayments,
        checkBackupCounts,
        importBackupStudents,
        backupPayload
    };
}
