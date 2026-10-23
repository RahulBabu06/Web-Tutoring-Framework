import express from "express";
import { RefundStatus } from "../config/classes.js";

export function createAdminParentsRouter({
    approveRefundRequest,
    asyncHandler,
    cleanString,
    getRefundRequest,
    isMissingAdminSchema,
    isParentAuthConfigured,
    isSupabaseConfigured,
    isUuid,
    listAdminParentLinkRequests,
    listAdminRefundRequests,
    loadAdminData,
    refundSchemaUpdateMessage,
    requireAdmin,
    reviewParentLinkRequest,
    reviewRefundRequest,
    unlinkParentLink
}) {
    const router = express.Router();

    router.get("/admin/refund-requests", requireAdmin, asyncHandler(async (req, res) => {
        let refundRequests = { pending: [], reviewed: [] };
        const setupError = await loadAdminData(async () => {
            refundRequests = await listAdminRefundRequests();
        }, "The refund requests table hasn't been created yet. Run the latest supabase/schema.sql, then refresh this page.");

        res.render("admin-refund-requests", {
            pending: refundRequests.pending,
            reviewed: refundRequests.reviewed,
            pendingTruncated: Boolean(refundRequests.pendingTruncated),
            queueLimit: refundRequests.queueLimit || 0,
            saved: req.query.saved || "",
            alreadyReviewed: req.query.reviewed === "1",
            isSupabaseConfigured,
            setupError
        });
    }));

    router.post("/admin/refund-requests/:id", requireAdmin, asyncHandler(async (req, res) => {
        const request = isUuid(req.params.id) ? await getRefundRequest(req.params.id) : null;

        if (!request) {
            return res.status(404).send("Refund request not found.");
        }

        if (request.status !== RefundStatus.pending) {
            return res.redirect("/admin/refund-requests?reviewed=1");
        }

        if (req.body.action !== "approve" && req.body.action !== "decline") {
            return res.status(400).send("Unknown refund review action.");
        }

        const approve = req.body.action === "approve";
        const adminNotes = cleanString(req.body.adminNotes).slice(0, 1000);
        let claimed;

        try {
            claimed = approve
                ? await approveRefundRequest(request.id, adminNotes)
                : await reviewRefundRequest(request.id, { status: RefundStatus.declined, adminNotes });
        } catch (error) {
            if (isMissingAdminSchema(error, ["approve_refund_request"])) {
                return res.status(503).send(refundSchemaUpdateMessage);
            }

            throw error;
        }

        if (!claimed) {
            return res.redirect("/admin/refund-requests?reviewed=1");
        }

        res.redirect(`/admin/refund-requests?saved=${approve ? RefundStatus.approved : RefundStatus.declined}`);
    }));

    function renderParentLinks(res, options = {}) {
        res.status(options.status || 200).render("admin-parent-links", {
            linkRequests: options.linkRequests || { links: [], students: [] },
            errors: options.errors || [],
            saved: Boolean(options.saved),
            unlinked: options.unlinked || "",
            isSupabaseConfigured,
            isParentAuthConfigured,
            setupError: options.setupError || ""
        });
    }

    router.get("/admin/parent-links", requireAdmin, asyncHandler(async (req, res) => {
        let linkRequests;
        const setupError = await loadAdminData(async () => {
            linkRequests = await listAdminParentLinkRequests();
        }, "The parent account database setup is incomplete. Ask the site administrator to finish the setup, then refresh this page.");

        renderParentLinks(res, {
            linkRequests,
            saved: req.query.saved === "1",
            unlinked: req.query.unlinked,
            setupError
        });
    }));

    router.post("/admin/parent-links/:id/unlink", requireAdmin, asyncHandler(async (req, res) => {
        if (!isSupabaseConfigured || !isUuid(req.params.id)) {
            return res.redirect("/admin/parent-links");
        }

        const result = await unlinkParentLink(req.params.id);
        const unlinked = !result ? "0" : result.emailStillOnStudentRecord ? "email-kept" : "1";
        res.redirect(`/admin/parent-links?unlinked=${unlinked}`);
    }));

    router.post("/admin/parent-links/:id", requireAdmin, asyncHandler(async (req, res) => {
        const action = req.body.action === "reject" ? "reject" : "approve";
        const studentId = cleanString(req.body.studentId);
        const errors = [];

        if (action === "approve" && !isUuid(studentId)) {
            errors.push("Choose the student record before approving the parent link.");
        }

        if (errors.length > 0) {
            return renderParentLinks(res, {
                status: 400,
                linkRequests: await listAdminParentLinkRequests(),
                errors
            });
        }

        try {
            await reviewParentLinkRequest(req.params.id, {
                action,
                studentId,
                reviewedNotes: cleanString(req.body.reviewedNotes)
            });
            res.redirect("/admin/parent-links?saved=1");
        } catch (error) {
            if (error.message.includes("already been reviewed") || error.message.includes("not found")) {
                return renderParentLinks(res, {
                    status: 400,
                    linkRequests: await listAdminParentLinkRequests(),
                    errors: ["This parent link request has already been reviewed."]
                });
            }

            if (error.code === "23505") {
                return renderParentLinks(res, {
                    status: 400,
                    linkRequests: await listAdminParentLinkRequests(),
                    errors: ["This parent is already linked to that student. Reject this request instead."]
                });
            }

            if (!isMissingAdminSchema(error)) {
                throw error;
            }

            renderParentLinks(res, {
                status: 400,
                errors: ["The parent account database setup is incomplete. Ask the site administrator to finish the setup."]
            });
        }
    }));

    return router;
}
