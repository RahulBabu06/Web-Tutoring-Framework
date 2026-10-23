import { AttendanceStatus } from "../config/classes.js";

export function createAttendanceService({
    cleanString,
    formatClassDateLabel,
    getClassCancellation,
    getFreeSkipsLeft,
    isMissingAdminSchema,
    listAttendanceForDate,
    listAttendanceForStudents,
    listPaymentsForStudents,
    listGroupClassStudents,
    normalizeAttendanceStatus,
    supabaseRequest,
    toAttendanceView,
    toInteger,
    upsertInChunks
}) {
    async function upsertAttendanceRows(rows) {
        if (rows.length === 0) {
            return [];
        }

        const savedRows = await upsertInChunks("/admin_attendance?on_conflict=student_id,class_date", rows);
        return savedRows.map(toAttendanceView);
    }

    async function saveClassRegister(groupClass, classDate, attendanceInput) {
        const students = (await listGroupClassStudents(groupClass)).filter((student) => attendanceInput?.[student.id]);
        const history = await listAttendanceForStudents(students.map((student) => student.id));
        const payments = await listPaymentsForStudents(students.map((student) => student.id));
        const attendanceRows = [];
        const notices = [];

        students.forEach((student) => {
            const entry = attendanceInput[student.id];
            const status = normalizeAttendanceStatus(entry.status);
            const studentHistory = history.filter((record) => record.studentId === student.id);
            let chargeType = "attended";
            let creditDelta = toInteger(entry.creditDelta, -1);
            const studentPayments = payments.filter((payment) => payment.studentId === student.id);

            if (status === AttendanceStatus.absent) {
                if (getFreeSkipsLeft(studentHistory, studentPayments, classDate) > 0) {
                    chargeType = "free_skip";
                } else {
                    chargeType = entry.waiveCharge ? "waived" : "charged";
                }

                creditDelta = chargeType === "charged" ? -1 : 0;
            }

            attendanceRows.push({
                student_id: student.id,
                class_date: classDate,
                status,
                credit_delta: creditDelta,
                charge_type: chargeType,
                notes: cleanString(entry.notes) || null
            });

            // The charge only looks at earlier skips; the count parents are told covers every other date.
            const historyWithThisClass = [
                ...studentHistory.filter((record) => record.classDate !== classDate),
                { classDate, chargeType, chargeTypeRecorded: true }
            ];

            notices.push({
                student,
                chargeType,
                creditDelta,
                payments: studentPayments,
                freeSkipsLeft: getFreeSkipsLeft(historyWithThisClass, studentPayments, "9999-12-31")
            });
        });

        // One transaction: attendance rows and the credit deltas against their locked previous values.
        const saved = attendanceRows.length === 0 ? [] : await supabaseRequest("/rpc/save_attendance_register", {
            method: "POST",
            body: JSON.stringify({ p_class_date: classDate, p_rows: attendanceRows })
        });
        const savedByStudent = new Map(saved.map((row) => [row.student_id, row]));

        notices.forEach((notice) => {
            const savedRow = savedByStudent.get(notice.student.id);
            notice.student = { ...notice.student, credits: toInteger(savedRow?.credits, notice.student.credits) };
        });

        return {
            marked: attendanceRows.length,
            creditUpdates: saved.filter((row) => toInteger(row.credit_difference) !== 0).length,
            notices
        };
    }

    async function loadClassDateStatus(groupClass, classDate, roster) {
        const rosterIds = new Set(roster.map((student) => student.id));
        const [attendance, cancellation] = await Promise.all([
            listAttendanceForDate(classDate).then((rows) => rows.filter((row) => rosterIds.has(row.studentId))),
            getClassCancellation(groupClass, classDate).catch((error) => {
                if (isMissingAdminSchema(error)) {
                    return null;
                }

                throw error;
            })
        ]);

        const markedIds = new Set(attendance.map((row) => row.studentId));
        const unmarkedCount = roster.filter((student) => !markedIds.has(student.id)).length;

        return {
            date: classDate,
            label: formatClassDateLabel(classDate),
            rosterCount: roster.length,
            unmarkedCount,
            registerStarted: attendance.length > 0,
            registerTaken: roster.length > 0 && unmarkedCount === 0,
            cancellation
        };
    }

    return {
        upsertAttendanceRows,
        saveClassRegister,
        loadClassDateStatus
    };
}
