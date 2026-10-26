import express from "express";
import { AttendanceStatus, getGroupClass, groupClasses } from "../config/classes.js";
import { inputLimits } from "../config/env.js";

export function createAdminAttendanceRouter({
    asyncHandler,
    cancelClass,
    classDateJobKey,
    cleanString,
    formatClassDateLabel,
    getClassCancellation,
    getFreeSkipsLeft,
    getLocalNow,
    isGmailConfigured,
    isMissingAdminSchema,
    isSupabaseConfigured,
    listAttendanceForDate,
    listAttendanceForStudents,
    listPaymentsForStudents,
    listGroupClassStudents,
    loadAdminData,
    maxFreeSkipsHeld,
    normalizeClassDate,
    parentEmailsEnabled,
    queueParentEmails,
    requireAdmin,
    restoreClass,
    runForClassDate,
    saveClassRegister,
    sendAttendanceEmails,
    sendCancellationEmails,
    sendClassRestoredEmails
}) {
    const router = express.Router();

    function classUrl(groupClass, classDate, query = "") {
        return `/admin/classes/${encodeURIComponent(groupClass.id)}?date=${encodeURIComponent(classDate)}${query}`;
    }

    function findGroupClass(req, res, next) {
        req.groupClass = getGroupClass(req.params.classId);

        if (!req.groupClass) {
            return res.status(404).render("admin-classes", { groupClasses, notFound: true });
        }

        next();
    }

    router.get("/admin/classes", requireAdmin, (req, res) => {
        if (groupClasses.length === 1) {
            return res.redirect(`/admin/classes/${encodeURIComponent(groupClasses[0].id)}`);
        }

        res.render("admin-classes", { groupClasses, notFound: false });
    });

    router.get("/admin/classes/:classId", requireAdmin, findGroupClass, asyncHandler(async (req, res) => {
        const { groupClass } = req;
        const classDate = normalizeClassDate(req.query.date, groupClass);
        let students = [];
        let attendanceByStudentId = new Map();
        let history = [];
        let payments = [];
        let cancellation = null;
        const setupError = await loadAdminData(async () => {
            students = await listGroupClassStudents(groupClass);
            const attendance = await listAttendanceForDate(classDate);
            attendanceByStudentId = new Map(attendance.map((record) => [record.studentId, record]));
            history = await listAttendanceForStudents(students.map((student) => student.id));
            payments = await listPaymentsForStudents(students.map((student) => student.id));
            cancellation = await getClassCancellation(groupClass, classDate);
        });

        const registerRows = students.map((student) => {
            const studentPayments = payments.filter((payment) => payment.studentId === student.id);

            return {
                student,
                attendance: attendanceByStudentId.get(student.id) || null,
                freeSkipsLeft: getFreeSkipsLeft(history.filter((record) => record.studentId === student.id), studentPayments, classDate),
                freeSkipAllowance: maxFreeSkipsHeld
            };
        });

        res.render("admin-class", {
            groupClass,
            registerRows,
            cancellation,
            cancelNotice: cleanString(req.query.cancel),
            isSupabaseConfigured,
            setupError,
            saved: req.query.saved === "1",
            schemaUpdateNeeded: req.query.schemaUpdate === "1",
            classDate,
            classDateLabel: formatClassDateLabel(classDate),
            className: groupClass.name,
            classTime: groupClass.time,
            parentEmailsWillSend: parentEmailsEnabled && isGmailConfigured,
            totalCredits: registerRows.reduce((total, row) => total + row.student.credits, 0)
        });
    }));

    router.post("/admin/classes/:classId/register", requireAdmin, findGroupClass, asyncHandler(async (req, res) => {
        const { groupClass } = req;
        const classDate = normalizeClassDate(req.body.classDate, groupClass);
        const jobKey = classDateJobKey(groupClass, classDate);

        if (!isSupabaseConfigured) {
            return res.redirect(classUrl(groupClass, classDate));
        }

        if (await getClassCancellation(groupClass, classDate)) {
            return res.redirect(classUrl(groupClass, classDate));
        }

        const attendanceInput = req.body.attendance || {};
        const allowedStatuses = Object.values(AttendanceStatus);
        const hasUnknownStatus = Object.values(attendanceInput).some((entry) => (
            entry?.status !== undefined && !allowedStatuses.includes(entry.status)
        ));

        if (hasUnknownStatus) {
            return res.status(400).send("Unknown attendance status.");
        }

        let result;

        try {
            result = await saveClassRegister(groupClass, classDate, attendanceInput);
        } catch (error) {
            if (isMissingAdminSchema(error, ["charge_type", "save_attendance_register"])) {
                return res.redirect(classUrl(groupClass, classDate, "&schemaUpdate=1"));
            }

            if (!isMissingAdminSchema(error)) {
                throw error;
            }

            return res.redirect(classUrl(groupClass, classDate));
        }

        queueParentEmails("attendance", () => sendAttendanceEmails(groupClass, classDate, result.notices));
        res.redirect(classUrl(groupClass, classDate, "&saved=1"));
    }));

    router.post("/admin/classes/:classId/cancel", requireAdmin, findGroupClass, asyncHandler(async (req, res) => {
        const { groupClass } = req;
        const classDate = normalizeClassDate(req.body.classDate, groupClass);
        const jobKey = classDateJobKey(groupClass, classDate);
        const back = (notice) => res.redirect(classUrl(groupClass, classDate, `&cancel=${notice}`));

        if (!isSupabaseConfigured) {
            return back("setup");
        }

        if (classDate < getLocalNow().date) {
            return back("past");
        }

        const rosterIds = new Set((await listGroupClassStudents(groupClass)).map((student) => student.id));

        if ((await listAttendanceForDate(classDate)).some((record) => rosterIds.has(record.studentId))) {
            return back("has-register");
        }

        const reason = cleanString(req.body.reason).slice(0, inputLimits.cancelReason);

        try {
            await runForClassDate(jobKey, () => cancelClass(groupClass, classDate, reason));
        } catch (error) {
            if (isMissingAdminSchema(error, ["class_cancellations"])) {
                return back("setup");
            }

            throw error;
        }

        queueParentEmails("cancellation", () => runForClassDate(jobKey, async () => {
            if (await getClassCancellation(groupClass, classDate)) {
                await sendCancellationEmails(groupClass, classDate, reason);
            }
        }));
        back("cancelled");
    }));

    router.post("/admin/classes/:classId/uncancel", requireAdmin, findGroupClass, asyncHandler(async (req, res) => {
        const { groupClass } = req;
        const classDate = normalizeClassDate(req.body.classDate, groupClass);
        const jobKey = classDateJobKey(groupClass, classDate);

        if (!isSupabaseConfigured) {
            return res.redirect(classUrl(groupClass, classDate));
        }

        const notified = await runForClassDate(jobKey, () => restoreClass(groupClass, classDate));

        if (parentEmailsEnabled && isGmailConfigured && notified.length > 0) {
            queueParentEmails("class restored", () => runForClassDate(jobKey, () => sendClassRestoredEmails(groupClass, classDate, notified)));
        }

        res.redirect(classUrl(groupClass, classDate, "&cancel=restored"));
    }));

    return router;
}
