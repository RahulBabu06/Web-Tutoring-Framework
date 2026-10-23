import { LinkStatus } from "../config/classes.js";
import { inFilter } from "../integrations/supabase.js";

export function createParentLinkService({
    adminReviewHistoryLimit,
    adminReviewQueueLimit,
    findUniqueStudentByName,
    getParentLink,
    getStudent,
    normalizeChildName,
    supabaseRequest,
    toParentLinkView,
    toParentProfileView
}) {
    const adminParentLinkSelect = "select=*,parent:parent_profiles(id,email,full_name,phone),student:admin_students(id,name)";

    function toAdminParentLinkView(row) {
        return toParentLinkView(
            row,
            row.parent ? toParentProfileView(row.parent) : null,
            row.student ? { id: row.student.id, name: row.student.name || "" } : null
        );
    }

    function byCreatedAtDesc(a, b) {
        return Date.parse(b.created_at) - Date.parse(a.created_at);
    }

    async function listAdminParentLinkRequests() {
        const linksPath = `/parent_student_links?${adminParentLinkSelect}&order=created_at.desc`;
        const [pendingRows, approvedRows, rejectedRows, studentRows] = await Promise.all([
            supabaseRequest(`${linksPath}&status=eq.${LinkStatus.pending}&limit=${adminReviewQueueLimit + 1}`),
            supabaseRequest(`${linksPath}&status=eq.${LinkStatus.approved}&limit=${adminReviewHistoryLimit}`),
            supabaseRequest(`${linksPath}&status=eq.${LinkStatus.rejected}&limit=${adminReviewHistoryLimit}`),
            supabaseRequest("/admin_students?select=id,name&order=name.asc")
        ]);
        const reviewedRows = [...approvedRows, ...rejectedRows].sort(byCreatedAtDesc);
        const students = studentRows.map((row) => ({ id: row.id, name: row.name || "" }));

        return {
            links: [...pendingRows.slice(0, adminReviewQueueLimit), ...reviewedRows].map(toAdminParentLinkView).map((link) => ({
                ...link,
                suggestedStudent: link.status === LinkStatus.pending
                    ? link.student || findUniqueStudentByName(students, link.requestedChildName)
                    : null
            })),
            students,
            pendingTruncated: pendingRows.length > adminReviewQueueLimit,
            rejectedTruncated: rejectedRows.length >= adminReviewHistoryLimit,
            queueLimit: adminReviewQueueLimit,
            historyLimit: adminReviewHistoryLimit
        };
    }

    async function reviewParentLinkRequest(linkId, reviewInput) {
        const existingLink = await getParentLink(linkId);

        if (!existingLink) {
            throw new Error("Parent link request not found.");
        }

        if (existingLink.status !== LinkStatus.pending) {
            throw new Error("Parent link request has already been reviewed.");
        }

        const isApproval = reviewInput.action === "approve";
        const row = {
            status: isApproval ? LinkStatus.approved : LinkStatus.rejected,
            student_id: isApproval ? reviewInput.studentId : null,
            reviewed_notes: reviewInput.reviewedNotes || null,
            reviewed_at: new Date().toISOString()
        };

        const rows = await supabaseRequest(`/parent_student_links?id=eq.${encodeURIComponent(linkId)}&status=eq.${LinkStatus.pending}`, {
            method: "PATCH",
            headers: {
                Prefer: "return=representation"
            },
            body: JSON.stringify(row)
        });

        if (!rows[0]) {
            throw new Error("Parent link request has already been reviewed.");
        }

        return toParentLinkView(rows[0]);
    }

    async function unlinkParentLink(linkId) {
        const rows = await supabaseRequest(`/parent_student_links?id=eq.${encodeURIComponent(linkId)}&status=eq.${LinkStatus.approved}`, {
            method: "DELETE",
            headers: {
                Prefer: "return=representation"
            }
        });
        const link = rows[0];

        if (!link) {
            return null;
        }

        // Rejections that this approval had replaced would otherwise reappear on the parent's dashboard.
        const approvalRequestedAt = new Date(link.requested_at || link.created_at).getTime();
        const rejected = await supabaseRequest(`/parent_student_links?select=id,requested_child_name,requested_at,created_at&parent_id=eq.${encodeURIComponent(link.parent_id)}&status=eq.${LinkStatus.rejected}`);
        const superseded = rejected.filter((row) => normalizeChildName(row.requested_child_name) === normalizeChildName(link.requested_child_name)
            && new Date(row.requested_at || row.created_at).getTime() < approvalRequestedAt);

        if (superseded.length > 0) {
            await supabaseRequest(`/parent_student_links?id=${inFilter(superseded.map((row) => row.id))}`, { method: "DELETE" });
        }

        const [profiles, student] = await Promise.all([
            supabaseRequest(`/parent_profiles?select=email&id=eq.${encodeURIComponent(link.parent_id)}`),
            link.student_id ? getStudent(link.student_id) : null
        ]);
        const parentEmail = ((profiles[0] && profiles[0].email) || "").toLowerCase();

        return {
            emailStillOnStudentRecord: Boolean(parentEmail && student && (student.parentEmail || "").toLowerCase() === parentEmail)
        };
    }

    return {
        adminParentLinkSelect,
        toAdminParentLinkView,
        byCreatedAtDesc,
        listAdminParentLinkRequests,
        reviewParentLinkRequest,
        unlinkParentLink
    };
}
