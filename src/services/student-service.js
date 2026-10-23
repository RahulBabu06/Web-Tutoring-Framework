import { inFilter } from "../integrations/supabase.js";

export function createStudentService({
    getRowById,
    listAllRows,
    supabaseRequest,
    toPaymentView,
    toStudentRow,
    toStudentView
}) {
    async function listStudentPayments(studentId) {
        const rows = await supabaseRequest(`/admin_payments?select=*&student_id=eq.${encodeURIComponent(studentId)}&order=paid_at.desc,created_at.desc`);
        return rows.map(toPaymentView);
    }

    async function listPaymentsForStudents(studentIds, order = "") {
        if (studentIds.length === 0) {
            return [];
        }

        const rows = await listAllRows("admin_payments", order, `student_id=${inFilter(studentIds)}`);
        return rows.map(toPaymentView);
    }

    async function getStudent(id) {
        return getRowById("admin_students", id, toStudentView);
    }

    async function listStudentsByIds(ids) {
        if (ids.length === 0) {
            return [];
        }

        const rows = await supabaseRequest(`/admin_students?select=*&id=${inFilter(ids)}`);
        return rows.map(toStudentView);
    }

    async function createStudent(studentInput) {
        const rows = await supabaseRequest("/admin_students", {
            method: "POST",
            headers: {
                Prefer: "return=representation"
            },
            body: JSON.stringify(toStudentRow(studentInput))
        });
        return toStudentView(rows[0]);
    }

    // Credits are only written when the admin changed them, and only if the balance is still the one
    // the form showed, so a payment or register save that landed meanwhile is never overwritten.
    async function updateStudent(id, studentInput, originalCredits) {
        const row = toStudentRow(studentInput);
        let path = `/admin_students?id=eq.${encodeURIComponent(id)}`;

        if (row.credits === originalCredits) {
            delete row.credits;
        } else {
            path += `&credits=eq.${originalCredits}`;
        }

        const rows = await supabaseRequest(path, {
            method: "PATCH",
            headers: {
                Prefer: "return=representation"
            },
            body: JSON.stringify(row)
        });
        return rows[0] ? toStudentView(rows[0]) : null;
    }

    async function bulkUpdateStudents(ids, changes) {
        const rows = await supabaseRequest(`/admin_students?id=${inFilter(ids)}`, {
            method: "PATCH",
            headers: {
                Prefer: "return=representation"
            },
            body: JSON.stringify({
                ...changes,
                updated_at: new Date().toISOString()
            })
        });
        return rows;
    }

    return {
        listStudentPayments,
        listPaymentsForStudents,
        getStudent,
        listStudentsByIds,
        createStudent,
        updateStudent,
        bulkUpdateStudents
    };
}
