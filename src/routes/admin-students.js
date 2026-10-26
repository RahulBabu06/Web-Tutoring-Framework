import express from "express";
import { sendNotFound } from "../middleware/errors.js";
import { StudentStatus, classOptions } from "../config/classes.js";
import { inputLimits } from "../config/env.js";

export function createAdminStudentsRouter({
    asyncHandler,
    bulkUpdateStudents,
    cleanString,
    createStudent,
    formatPaymentDateInput,
    getAttendanceRecord,
    getFreeSkipsLeft,
    getStudent,
    isChargedAbsence,
    isDateInput,
    isMissingAdminSchema,
    isSupabaseConfigured,
    isUuid,
    listAttendanceHistory,
    listStudentPayments,
    listStudents,
    loadAdminData,
    maxFreeSkipsHeld,
    normalizePaymentInput,
    normalizeStudentInput,
    queueParentEmails,
    recordPayment,
    refundChargedAbsence,
    refundSchemaUpdateMessage,
    requireAdmin,
    sendPaymentReceipt,
    setupIncompleteMessage,
    toInteger,
    updateStudent
}) {
    const router = express.Router();

    const noClassFilter = "none";
    const maxBulkStudents = 500;

    function readStudentListFilters(source) {
        const classFilter = cleanString(source.class);

        return {
            view: source.view === StudentStatus.inactive ? StudentStatus.inactive : StudentStatus.active,
            q: cleanString(source.q).slice(0, inputLimits.studentSearch),
            classFilter: classFilter === noClassFilter || classOptions.includes(classFilter) ? classFilter : ""
        };
    }

    function studentListUrl(filters, extra = {}) {
        const params = new URLSearchParams();

        if (filters.view === StudentStatus.inactive) {
            params.set("view", StudentStatus.inactive);
        }

        if (filters.q) {
            params.set("q", filters.q);
        }

        if (filters.classFilter) {
            params.set("class", filters.classFilter);
        }

        Object.entries(extra).forEach(([key, value]) => params.set(key, String(value)));
        const query = params.toString();
        return query ? `/admin/students?${query}` : "/admin/students";
    }

    function studentSearchText(student) {
        return [student.name, student.parentName, student.parentEmail, student.phone, student.preferredClass, student.displayNotes]
            .join(" ")
            .toLowerCase();
    }

    function filterStudentList(students, filters) {
        const terms = filters.q.toLowerCase().split(/\s+/).filter(Boolean);

        return students.filter((student) => {
            if ((student.status === StudentStatus.inactive ? StudentStatus.inactive : StudentStatus.active) !== filters.view) {
                return false;
            }

            if (filters.classFilter === noClassFilter ? student.preferredClass : filters.classFilter && student.preferredClass !== filters.classFilter) {
                return false;
            }

            const text = studentSearchText(student);
            return terms.every((term) => text.includes(term));
        });
    }

    function parseBulkStudentAction(action) {
        if (action === "status:active" || action === "status:inactive") {
            const status = action.slice("status:".length);
            return {
                changes: { status },
                summary: `marked ${status}`
            };
        }

        if (action.startsWith("class:")) {
            const preferredClass = action.slice("class:".length);

            if (preferredClass === noClassFilter) {
                return {
                    changes: { preferred_class: null },
                    summary: "moved to No class"
                };
            }

            if (classOptions.includes(preferredClass)) {
                return {
                    changes: { preferred_class: preferredClass },
                    summary: `moved to ${preferredClass}`
                };
            }
        }

        return null;
    }

    router.get("/admin/students", requireAdmin, asyncHandler(async (req, res) => {
        let students = [];
        const setupError = await loadAdminData(async () => {
            students = await listStudents();
        });

        const filters = readStudentListFilters(req.query);
        const bulkCount = toInteger(req.query.bulkCount);
        const bulkAction = parseBulkStudentAction(cleanString(req.query.bulkAction));

        res.render("admin-students", {
            students: filterStudentList(students, { ...filters, q: "" }).map((student) => ({
                ...student,
                searchText: studentSearchText(student),
                matchesSearch: filterStudentList([student], filters).length > 0
            })),
            totalStudents: students.length,
            activeCount: students.filter((student) => student.status !== StudentStatus.inactive).length,
            inactiveCount: students.filter((student) => student.status === StudentStatus.inactive).length,
            filters,
            classOptions,
            noClassFilter,
            viewUrl: (view) => studentListUrl({ ...filters, view }),
            clearUrl: studentListUrl({ view: filters.view, q: "", classFilter: "" }),
            bulkMessage: bulkAction && bulkCount > 0
                ? `${bulkCount} ${bulkCount === 1 ? "student" : "students"} ${bulkAction.summary}.`
                : "",
            bulkError: req.query.bulkError === "1",
            saved: req.query.saved === "1",
            isSupabaseConfigured,
            setupError
        });
    }));

    router.get("/admin/students/new", requireAdmin, (req, res) => {
        if (!isSupabaseConfigured) {
            return res.redirect("/admin/students");
        }

        res.render("admin-student-form", {
            mode: "new",
            errors: [],
            student: {
                name: typeof req.query.name === "string" ? req.query.name.slice(0, 100) : "",
                parentName: "",
                parentEmail: typeof req.query.parentEmail === "string" ? req.query.parentEmail.slice(0, 254) : "",
                phone: "",
                preferredClass: "",
                credits: 0,
                status: StudentStatus.active,
                notes: ""
            }
        });
    });

    router.post("/admin/students", requireAdmin, asyncHandler(async (req, res) => {
        const studentInput = normalizeStudentInput(req.body);
        const errors = [];

        if (!studentInput.name) {
            errors.push("Student name is required.");
        }

        if (studentInput.parentEmail && !studentInput.parentEmail.includes("@")) {
            errors.push("Parent email must look like an email address.");
        }

        if (errors.length > 0) {
            return res.status(400).render("admin-student-form", {
                mode: "new",
                errors,
                student: studentInput
            });
        }

        await createStudent(studentInput);
        res.redirect(studentInput.status === StudentStatus.inactive ? "/admin/students?view=inactive&saved=1" : "/admin/students?saved=1");
    }));

    router.get("/admin/students/:id/edit", requireAdmin, asyncHandler(async (req, res) => {
        if (!isUuid(req.params.id)) {
            return sendNotFound(res, "Student not found.");
        }

        const student = await getStudent(req.params.id);

        if (!student) {
            return sendNotFound(res, "Student not found.");
        }

        res.render("admin-student-form", {
            mode: "edit",
            errors: [],
            student
        });
    }));

    router.post("/admin/attendance/:id/refund", requireAdmin, asyncHandler(async (req, res) => {
        if (!isSupabaseConfigured || !isUuid(req.params.id)) {
            return sendNotFound(res, "Attendance record not found.");
        }

        const record = await getAttendanceRecord(req.params.id);

        if (!record) {
            return sendNotFound(res, "Attendance record not found.");
        }

        try {
            await refundChargedAbsence(record.id);
        } catch (error) {
            if (isMissingAdminSchema(error, ["refund_charged_absence"])) {
                return res.status(503).send(refundSchemaUpdateMessage);
            }

            throw error;
        }

        res.redirect(`/admin/students/${encodeURIComponent(record.studentId)}/attendance?refunded=1`);
    }));

    router.get("/admin/students/:id/attendance", requireAdmin, asyncHandler(async (req, res) => {
        if (!isUuid(req.params.id)) {
            return sendNotFound(res, "Student not found.");
        }

        let student = null;
        let attendance = [];
        let payments = [];
        let studentNotFound = false;
        const setupError = await loadAdminData(async () => {
            student = await getStudent(req.params.id);

            if (!student) {
                studentNotFound = true;
                return;
            }

            attendance = await listAttendanceHistory(req.params.id);
            payments = await listStudentPayments(req.params.id);
        });

        if (studentNotFound) {
            return sendNotFound(res, "Student not found.");
        }

        res.render("admin-student-attendance", {
            student,
            attendance,
            freeSkipsLeft: getFreeSkipsLeft(attendance, payments, "9999-12-31"),
            freeSkipAllowance: maxFreeSkipsHeld,
            isChargedAbsence,
            refunded: req.query.refunded === "1",
            setupError,
            isSupabaseConfigured
        });
    }));

    function renderStudentPayments(res, student, options = {}) {
        res.status(options.status || 200).render("admin-student-payments", {
            student,
            payments: options.payments || [],
            setupError: options.setupError || "",
            isSupabaseConfigured,
            saved: Boolean(options.saved),
            today: formatPaymentDateInput(options.paidAt),
            values: options.values || {},
            errors: options.errors || []
        });
    }

    router.get("/admin/students/:id/payments", requireAdmin, asyncHandler(async (req, res) => {
        if (!isUuid(req.params.id)) {
            return sendNotFound(res, "Student not found.");
        }

        let student = null;
        let payments = [];
        let studentNotFound = false;
        const setupError = await loadAdminData(async () => {
            student = await getStudent(req.params.id);

            if (!student) {
                studentNotFound = true;
                return;
            }

            payments = await listStudentPayments(req.params.id);
        });

        if (studentNotFound) {
            return sendNotFound(res, "Student not found.");
        }

        renderStudentPayments(res, student, {
            payments,
            setupError,
            saved: req.query.saved === "1"
        });
    }));

    router.post("/admin/students/bulk", requireAdmin, asyncHandler(async (req, res) => {
        const filters = readStudentListFilters(req.body);
        const rawIds = req.body.studentIds;
        const idList = rawIds && typeof rawIds === "object" ? Object.values(rawIds) : [rawIds];
        const studentIds = [...new Set(idList.map(String).filter(isUuid))];
        const bulkAction = cleanString(req.body.bulkAction);
        const action = parseBulkStudentAction(bulkAction);

        if (!action || studentIds.length === 0 || studentIds.length > maxBulkStudents) {
            return res.redirect(303, studentListUrl(filters, { bulkError: 1 }));
        }

        const rows = await bulkUpdateStudents(studentIds, action.changes);

        res.redirect(303, studentListUrl(filters, {
            bulkAction,
            bulkCount: rows.length
        }));
    }));

    router.post("/admin/students/:id/payments", requireAdmin, asyncHandler(async (req, res) => {
        if (!isUuid(req.params.id)) {
            return sendNotFound(res, "Student not found.");
        }

        if (!isSupabaseConfigured) {
            return res.redirect(`/admin/students/${req.params.id}/payments`);
        }

        const student = await getStudent(req.params.id);

        if (!student) {
            return sendNotFound(res, "Student not found.");
        }

        const paymentInput = normalizePaymentInput(req.body);
        const errors = [];

        if (paymentInput.amountPence <= 0) {
            errors.push("Payment amount must be greater than 0.");
        }

        if (!paymentInput.isValidCurrency) {
            errors.push("Currency must be a 3-letter code such as GBP, USD or EUR.");
        }

        if (!isDateInput(req.body.paidAt)) {
            errors.push("Payment date is required.");
        }

        if (errors.length > 0) {
            return renderStudentPayments(res, student, {
                status: 400,
                payments: await listStudentPayments(req.params.id),
                paidAt: req.body.paidAt,
                values: req.body,
                errors
            });
        }

        let payment;

        try {
            payment = await recordPayment(student, paymentInput);
        } catch (error) {
            if (!isMissingAdminSchema(error)) {
                throw error;
            }

            return renderStudentPayments(res, student, {
                status: 400,
                setupError: setupIncompleteMessage,
                paidAt: req.body.paidAt
            });
        }

        queueParentEmails("payment receipt", () => sendPaymentReceipt(student.id, payment));
        res.redirect(`/admin/students/${req.params.id}/payments?saved=1`);
    }));

    router.post("/admin/students/:id", requireAdmin, asyncHandler(async (req, res) => {
        if (!isUuid(req.params.id)) {
            return sendNotFound(res, "Student not found.");
        }

        const studentInput = normalizeStudentInput(req.body);
        const errors = [];

        if (!studentInput.name) {
            errors.push("Student name is required.");
        }

        if (studentInput.parentEmail && !studentInput.parentEmail.includes("@")) {
            errors.push("Parent email must look like an email address.");
        }

        const student = await getStudent(req.params.id);
        if (!student) {
            return sendNotFound(res, "Student not found.");
        }

        const originalCredits = req.body.originalCredits === undefined ? student.credits : toInteger(req.body.originalCredits);

        if (errors.length > 0) {
            return res.status(400).render("admin-student-form", {
                mode: "edit",
                errors,
                student: {
                    id: req.params.id,
                    ...studentInput,
                    originalCredits
                }
            });
        }

        if (!await updateStudent(req.params.id, studentInput, originalCredits)) {
            const current = await getStudent(req.params.id);

            if (!current) {
                return sendNotFound(res, "Student not found.");
            }

            return res.status(409).render("admin-student-form", {
                mode: "edit",
                errors: [`Not saved: lesson credits changed from ${originalCredits} to ${current.credits} while you were editing (for example a payment or register save). Check the balance and save again.`],
                student: {
                    id: req.params.id,
                    ...studentInput,
                    credits: current.credits,
                    originalCredits: current.credits
                }
            });
        }
        res.redirect(studentInput.status === StudentStatus.inactive ? "/admin/students?view=inactive&saved=1" : "/admin/students?saved=1");
    }));

    return router;
}
