import { LinkStatus } from "../config/classes.js";

export function createParentService({
    formatFriendlyDate,
    getFreeSkipsLeft,
    getRowById,
    listAttendanceForStudents,
    listPaymentsForStudents,
    listRefundRequestsForParent,
    listStudentsByIds,
    maxFreeSkipsHeld,
    maxPendingChildLinkRequests,
    pendingChildLinkCapErrorCode,
    supabaseAuthRequest,
    supabaseRequest,
    toParentAttendanceView,
    toParentLinkView,
    toParentPaymentView,
    toParentProfileView
}) {
    async function signUpParentAccount(parentInput, redirectTo) {
        const authPayload = await supabaseAuthRequest(`/signup?redirect_to=${encodeURIComponent(redirectTo)}`, {
            method: "POST",
            body: JSON.stringify({
                email: parentInput.email,
                password: parentInput.password,
                data: {
                    full_name: parentInput.fullName,
                    phone: parentInput.phone
                }
            })
        });
        const user = authPayload.user;

        if (authPayload.access_token && user?.id) {
            await upsertParentProfile({
                id: user.id,
                email: user.email || parentInput.email,
                fullName: parentInput.fullName,
                phone: parentInput.phone
            });
        }

        return authPayload;
    }

    async function signInParentAccount(parentInput) {
        const session = await supabaseAuthRequest("/token?grant_type=password", {
            method: "POST",
            body: JSON.stringify({
                email: parentInput.email,
                password: parentInput.password
            })
        });
        const metadata = session.user?.user_metadata || {};

        if (session.user?.id) {
            const existingProfile = await getParentProfile(session.user.id);

            if (existingProfile) {
                return session;
            }

            await upsertParentProfile({
                id: session.user.id,
                email: session.user.email || parentInput.email,
                fullName: metadata.full_name || parentInput.email,
                phone: metadata.phone || ""
            });
        }

        return session;
    }

    async function sendParentPasswordReset(email, redirectTo) {
        await supabaseAuthRequest(`/recover?redirect_to=${encodeURIComponent(redirectTo)}`, {
            method: "POST",
            body: JSON.stringify({ email })
        });
    }

    async function updateParentPassword(accessToken, password) {
        await supabaseAuthRequest("/user", {
            method: "PUT",
            accessToken,
            body: JSON.stringify({ password })
        });
    }

    async function signOutParentAccount(accessToken) {
        if (!accessToken) {
            return;
        }

        try {
            await supabaseAuthRequest("/logout", {
                method: "POST",
                accessToken
            });
        } catch (error) {
            console.error("Parent logout failed:", error.message);
        }
    }

    async function getParentProfile(parentId) {
        return getRowById("parent_profiles", parentId, toParentProfileView);
    }

    async function ensureParentProfileForUser(user) {
        const existingProfile = await getParentProfile(user.id);

        if (existingProfile) {
            return existingProfile;
        }

        const metadata = user.user_metadata || {};
        return upsertParentProfile({
            id: user.id,
            email: user.email || "",
            fullName: metadata.full_name || user.email || "Parent",
            phone: metadata.phone || ""
        });
    }

    async function upsertParentProfile(parentInput) {
        const rows = await supabaseRequest("/parent_profiles?on_conflict=id", {
            method: "POST",
            headers: {
                Prefer: "resolution=merge-duplicates,return=representation"
            },
            body: JSON.stringify({
                id: parentInput.id,
                email: parentInput.email,
                full_name: parentInput.fullName,
                phone: parentInput.phone || null
            })
        });
        return rows[0] ? toParentProfileView(rows[0]) : null;
    }

    async function listParentLinks(parentId) {
        const rows = await supabaseRequest(`/parent_student_links?parent_id=eq.${encodeURIComponent(parentId)}&select=*&order=created_at.desc`);
        return rows.map((row) => toParentLinkView(row));
    }

    function normalizeChildName(name) {
        return (name || "").trim().toLowerCase();
    }

    function parentHasApprovedLink(links, studentId) {
        return links.some((link) => link.status === LinkStatus.approved && link.studentId === studentId);
    }

    async function getParentLink(linkId) {
        return getRowById("parent_student_links", linkId, (row) => toParentLinkView(row));
    }

    function findUniqueStudentByName(students, name) {
        const normalizedName = normalizeChildName(name);

        if (!normalizedName) {
            return null;
        }

        const matches = students.filter((student) => normalizeChildName(student.name) === normalizedName);
        return matches.length === 1 ? matches[0] : null;
    }

    // The student record is only chosen by the admin, and the response never depends on whether the
    // name matches a student, so a parent can't use this to find out who is enrolled.
    async function createParentChildLinkRequest(parentId, childInput) {
        const pendingLinks = (await listParentLinks(parentId)).filter((link) => link.status === LinkStatus.pending);

        if (pendingLinks.some((link) => normalizeChildName(link.requestedChildName) === normalizeChildName(childInput.childName))) {
            return { created: false };
        }

        if (pendingLinks.length >= maxPendingChildLinkRequests) {
            return { created: false, tooManyPending: true };
        }

        try {
            await supabaseRequest("/parent_student_links", {
                method: "POST",
                headers: {
                    Prefer: "return=representation"
                },
                body: JSON.stringify({
                    parent_id: parentId,
                    student_id: null,
                    requested_child_name: childInput.childName,
                    relationship: childInput.relationship || null,
                    notes: childInput.notes || null
                })
            });
        } catch (error) {
            // A concurrent submit got there first: parent_student_links_pending_child_name_idx or the
            // enforce_pending_child_link_cap trigger in supabase/schema.sql.
            if (error.code === "23505") {
                return { created: false };
            }

            if (error.code === pendingChildLinkCapErrorCode) {
                return { created: false, tooManyPending: true };
            }

            throw error;
        }

        return { created: true };
    }

    const recentRejectedRequestWindowMs = 30 * 24 * 60 * 60 * 1000;

    async function listParentDashboardChildren(parentId) {
        const links = await listParentLinks(parentId);
        const children = [];
        const refundsByAttendanceId = new Map();

        (await listRefundRequestsForParent(parentId)).forEach((request) => {
            if (!refundsByAttendanceId.has(request.attendanceId)) {
                refundsByAttendanceId.set(request.attendanceId, request);
            }
        });

        const approvedLinks = links.filter((item) => item.status === LinkStatus.approved && item.studentId);
        const studentIds = [...new Set(approvedLinks.map((link) => link.studentId))];
        const [students, allAttendance, allPayments] = await Promise.all([
            listStudentsByIds(studentIds),
            listAttendanceForStudents(studentIds, "class_date.desc"),
            listPaymentsForStudents(studentIds, "paid_at.desc,created_at.desc")
        ]);
        const studentsById = new Map(students.map((student) => [student.id, student]));
        const groupByStudentId = (records) => records.reduce((groups, record) => {
            groups.set(record.studentId, [...(groups.get(record.studentId) || []), record]);
            return groups;
        }, new Map());
        const attendanceByStudentId = groupByStudentId(allAttendance);
        const paymentsByStudentId = groupByStudentId(allPayments);

        for (const link of approvedLinks) {
            const student = studentsById.get(link.studentId);

            if (!student) {
                continue;
            }

            const attendance = attendanceByStudentId.get(student.id) || [];
            const payments = paymentsByStudentId.get(student.id) || [];

            children.push({
                link,
                student,
                attendance: attendance.slice(0, 6).map(toParentAttendanceView).map((record) => ({
                    ...record,
                    refundRequest: refundsByAttendanceId.get(record.id) || null,
                    canRequestRefund: record.chargeType === "charged" && record.creditDelta < 0 && !refundsByAttendanceId.has(record.id)
                })),
                freeSkipsLeft: getFreeSkipsLeft(attendance, payments, "9999-12-31"),
                freeSkipAllowance: maxFreeSkipsHeld,
                payments: payments.map(toParentPaymentView).slice(0, 6)
            });
        }

        const rejectedCutoff = Date.now() - recentRejectedRequestWindowMs;
        const hasNewerActiveRequest = (rejected) => links.some((item) =>
            (item.status === LinkStatus.pending || item.status === LinkStatus.approved)
            && normalizeChildName(item.requestedChildName) === normalizeChildName(rejected.requestedChildName)
            && new Date(item.requestedAt).getTime() > new Date(rejected.requestedAt).getTime());
        const withDateLabels = (link) => ({
            ...link,
            requestedLabel: formatFriendlyDate(link.requestedAt),
            reviewedLabel: formatFriendlyDate(link.reviewedAt)
        });

        return {
            children,
            pendingLinks: links.filter((item) => item.status === LinkStatus.pending).map(withDateLabels),
            rejectedLinks: links
                .filter((item) => item.status === LinkStatus.rejected && new Date(item.reviewedAt || item.updatedAt).getTime() >= rejectedCutoff)
                .filter((item) => !hasNewerActiveRequest(item))
                .map(withDateLabels)
        };
    }

    return {
        signUpParentAccount,
        signInParentAccount,
        sendParentPasswordReset,
        updateParentPassword,
        signOutParentAccount,
        getParentProfile,
        ensureParentProfileForUser,
        upsertParentProfile,
        listParentLinks,
        normalizeChildName,
        parentHasApprovedLink,
        getParentLink,
        findUniqueStudentByName,
        createParentChildLinkRequest,
        recentRejectedRequestWindowMs,
        listParentDashboardChildren
    };
}
