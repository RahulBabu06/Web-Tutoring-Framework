import { RefundStatus } from "../config/classes.js";

export function createRefundService({
    adminReviewHistoryLimit,
    adminReviewQueueLimit,
    formatFriendlyDate,
    getAttendanceRecord,
    getRowById,
    getStudent,
    isChargedAbsence,
    isMissingAdminSchema,
    isUuid,
    listParentLinks,
    parentHasApprovedLink,
    supabaseRequest,
    toAttendanceView,
    toInteger
}) {
    async function refundChargedAbsence(attendanceId) {
        const creditsRestored = await supabaseRequest("/rpc/refund_charged_absence", {
            method: "POST",
            body: JSON.stringify({ p_attendance_id: attendanceId })
        });
        return toInteger(creditsRestored) > 0;
    }

    // Claims the pending request and refunds its absence together; returns false if it was already reviewed.
    async function approveRefundRequest(requestId, adminNotes) {
        const result = await supabaseRequest("/rpc/approve_refund_request", {
            method: "POST",
            body: JSON.stringify({ p_request_id: requestId, p_admin_notes: adminNotes || null })
        });
        return Boolean(result?.claimed);
    }

    function toRefundRequestView(row) {
        return {
            id: row.id,
            attendanceId: row.attendance_id,
            studentId: row.student_id,
            parentId: row.parent_id,
            reason: row.reason || "",
            status: row.status,
            adminNotes: row.admin_notes || "",
            requestedAt: row.requested_at || row.created_at || "",
            reviewedAt: row.reviewed_at || "",
            requestedLabel: formatFriendlyDate(row.requested_at || row.created_at),
            reviewedLabel: formatFriendlyDate(row.reviewed_at)
        };
    }

    async function listRefundRequestsForParent(parentId) {
        try {
            const rows = await supabaseRequest(`/attendance_refund_requests?select=*&parent_id=eq.${encodeURIComponent(parentId)}&order=requested_at.desc`);
            return rows.map(toRefundRequestView);
        } catch (error) {
            if (isMissingAdminSchema(error)) {
                return [];
            }

            throw error;
        }
    }

    async function getRefundRequest(requestId) {
        return getRowById("attendance_refund_requests", requestId, toRefundRequestView);
    }

    async function createRefundRequest(input) {
        const rows = await supabaseRequest("/attendance_refund_requests", {
            method: "POST",
            headers: {
                Prefer: "return=representation"
            },
            body: JSON.stringify({
                attendance_id: input.attendanceId,
                student_id: input.studentId,
                parent_id: input.parentId,
                reason: input.reason
            })
        });
        return toRefundRequestView(rows[0]);
    }

    async function reviewRefundRequest(requestId, fields) {
        const rows = await supabaseRequest(`/attendance_refund_requests?id=eq.${encodeURIComponent(requestId)}&status=eq.${RefundStatus.pending}`, {
            method: "PATCH",
            headers: {
                Prefer: "return=representation"
            },
            body: JSON.stringify({
                status: fields.status,
                admin_notes: fields.adminNotes || null,
                reviewed_at: new Date().toISOString()
            })
        });
        return Array.isArray(rows) && rows.length > 0;
    }

    const adminRefundRequestSelect = "select=*,student:admin_students(name),parent:parent_profiles(full_name,email),attendance:admin_attendance(*)";

    function toAdminRefundRequestView(row) {
        const attendance = row.attendance ? toAttendanceView(row.attendance) : null;

        return {
            ...toRefundRequestView(row),
            studentName: row.student ? row.student.name || "" : "Unknown student",
            parentName: row.parent ? row.parent.full_name || "" : "Unknown parent",
            parentEmail: row.parent ? row.parent.email || "" : "",
            classDateLabel: attendance ? formatFriendlyDate(attendance.classDate) : "",
            stillCharged: Boolean(attendance && isChargedAbsence(attendance))
        };
    }

    async function listAdminRefundRequests() {
        const requestsPath = `/attendance_refund_requests?${adminRefundRequestSelect}&order=requested_at.desc`;
        const [pendingRows, reviewedRows] = await Promise.all([
            supabaseRequest(`${requestsPath}&status=eq.${RefundStatus.pending}&limit=${adminReviewQueueLimit + 1}`),
            supabaseRequest(`${requestsPath}&status=neq.${RefundStatus.pending}&limit=${adminReviewHistoryLimit}`)
        ]);

        return {
            pending: pendingRows.slice(0, adminReviewQueueLimit).map(toAdminRefundRequestView),
            reviewed: reviewedRows.map(toAdminRefundRequestView),
            pendingTruncated: pendingRows.length > adminReviewQueueLimit,
            queueLimit: adminReviewQueueLimit
        };
    }

    const refundAlreadyRequestedMessage = "You've already asked for a refund for this class.";

    async function getRefundableAttendanceForParent(parentId, attendanceId) {
        const notFound = { error: "We couldn't find that class." };

        if (!isUuid(attendanceId)) {
            return notFound;
        }

        const record = await getAttendanceRecord(attendanceId);
        const links = await listParentLinks(parentId);

        if (!record || !parentHasApprovedLink(links, record.studentId)) {
            return notFound;
        }

        if (!isChargedAbsence(record)) {
            return { error: "Only missed classes that used a lesson can be refunded." };
        }

        const requests = await listRefundRequestsForParent(parentId);

        if (requests.some((request) => request.attendanceId === record.id)) {
            return { error: refundAlreadyRequestedMessage };
        }

        const student = await getStudent(record.studentId);
        return { record, student };
    }

    return {
        refundChargedAbsence,
        approveRefundRequest,
        toRefundRequestView,
        listRefundRequestsForParent,
        getRefundRequest,
        createRefundRequest,
        reviewRefundRequest,
        adminRefundRequestSelect,
        toAdminRefundRequestView,
        listAdminRefundRequests,
        refundAlreadyRequestedMessage,
        getRefundableAttendanceForParent
    };
}
