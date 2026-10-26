import express from "express";
import { sendNotFound } from "../middleware/errors.js";
import { checkoutRateLimiter, childLinkRequestRateLimiter, refundRequestRateLimiter } from "../middleware/rate-limiters.js";
import { business, inputLimits } from "../config/env.js";

export function createParentsRouter({
    asyncHandler,
    cleanString,
    createParentChildLinkRequest,
    createRefundRequest,
    ensureParentProfileForUser,
    formatFriendlyDate,
    formatMoney,
    getOneToOneLesson,
    getPublicSiteOrigin,
    getRefundableAttendanceForParent,
    getStudent,
    isLessonPackForSale,
    isOneToOneLessonForSale,
    isStripeConfigured,
    isUuid,
    lessonPackCredits,
    lessonPackPricePence,
    listParentDashboardChildren,
    listParentLinks,
    lowCreditThreshold,
    maxFreeSkipsHeld,
    maxPendingChildLinkRequests,
    normalizeChildLinkRequestInput,
    oneToOneLessons,
    parentHasApprovedLink,
    recordStripeCheckoutPayment,
    refundAlreadyRequestedMessage,
    requireParent,
    sendAdminNotification,
    stripeRequest
}) {
    const router = express.Router();

    router.get("/parents/dashboard", (req, res) => {
        res.redirect("/parents");
    });

    router.get("/parents", requireParent, asyncHandler(async (req, res) => {
        const profile = await ensureParentProfileForUser(req.parentUser);
        const dashboard = await listParentDashboardChildren(req.parentUser.id);

        res.render("parent-dashboard", {
            profile,
            dashboard,
            requested: req.query.requested === "1",
            refundRequested: req.query.refundRequested === "1",
            checkoutStatus: ["paid", "processing", "cancelled"].includes(req.query.checkout) ? req.query.checkout : "",
            checkoutIsOneToOne: req.query.lesson === "one-to-one",
            lowCreditThreshold,
            maxFreeSkipsHeld,
            lessonPack: {
                enabled: isLessonPackForSale,
                credits: lessonPackCredits,
                priceLabel: formatMoney(lessonPackPricePence)
            },
            oneToOneLessons: Object.values(oneToOneLessons).filter(isOneToOneLessonForSale).sort((a, b) => b.minutes - a.minutes).map((lesson) => ({
                minutes: lesson.minutes,
                label: lesson.label,
                priceLabel: formatMoney(lesson.pricePence)
            }))
        });
    }));

    router.post("/parents/children/:studentId/checkout", checkoutRateLimiter, requireParent, asyncHandler(async (req, res) => {
        const requestedMinutes = cleanString(req.body.oneToOneMinutes);
        const oneToOneLesson = requestedMinutes ? getOneToOneLesson(requestedMinutes) : null;

        if (requestedMinutes && !oneToOneLesson) {
            return res.status(400).send("Unknown lesson type.");
        }

        if (oneToOneLesson ? !isOneToOneLessonForSale(oneToOneLesson) : !isLessonPackForSale) {
            return res.redirect("/parents");
        }

        const studentId = req.params.studentId;
        const links = await listParentLinks(req.parentUser.id);
        const student = isUuid(studentId) && parentHasApprovedLink(links, studentId)
            ? await getStudent(studentId)
            : null;

        if (!student) {
            return sendNotFound(res, "Student not found.");
        }

        const origin = getPublicSiteOrigin();
        const params = {
            mode: "payment",
            "line_items[0][quantity]": "1",
            "line_items[0][price_data][currency]": business.currency.toLowerCase(),
            "line_items[0][price_data][unit_amount]": String(oneToOneLesson ? oneToOneLesson.pricePence : lessonPackPricePence),
            "line_items[0][price_data][product_data][name]": oneToOneLesson
                ? `${oneToOneLesson.label} for ${student.name}`
                : `${lessonPackCredits} lessons for ${student.name}`,
            client_reference_id: student.id,
            "metadata[student_id]": student.id,
            "metadata[parent_id]": req.parentUser.id,
            "metadata[credits]": String(oneToOneLesson ? 0 : lessonPackCredits),
            success_url: `${origin}/parents/payments/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${origin}/parents?checkout=cancelled`
        };

        if (oneToOneLesson) {
            params["metadata[one_to_one_minutes]"] = String(oneToOneLesson.minutes);
        }

        if (req.parentUser.email) {
            params.customer_email = req.parentUser.email;
        }

        const session = await stripeRequest("/checkout/sessions", { method: "POST", params });
        res.redirect(303, session.url);
    }));

    router.get("/parents/payments/success", requireParent, asyncHandler(async (req, res) => {
        const sessionId = cleanString(req.query.session_id);

        if (!isStripeConfigured || !/^cs_[A-Za-z0-9_]+$/.test(sessionId)) {
            return res.redirect("/parents");
        }

        const session = await stripeRequest(`/checkout/sessions/${sessionId}`).catch((error) => {
            console.error("Stripe session lookup failed:", error.message);
            return null;
        });

        if (session?.metadata?.parent_id !== req.parentUser.id) {
            return res.redirect("/parents");
        }

        const lessonQuery = getOneToOneLesson(session.metadata?.one_to_one_minutes) ? "&lesson=one-to-one" : "";

        if (session.payment_status === "paid") {
            await recordStripeCheckoutPayment(session);
            return res.redirect(`/parents?checkout=paid${lessonQuery}`);
        }

        res.redirect(`/parents?checkout=processing${lessonQuery}`);
    }));

    router.get("/parents/children/new", requireParent, (req, res) => {
        res.render("parent-child-request", {
            errors: [],
            values: {
                childName: cleanString(req.query.childName).slice(0, inputLimits.childName),
                relationship: cleanString(req.query.relationship).slice(0, inputLimits.childRelationship)
            }
        });
    });

    router.post("/parents/children", requireParent, childLinkRequestRateLimiter, asyncHandler(async (req, res) => {
        const values = normalizeChildLinkRequestInput(req.body);
        const errors = [];

        if (!values.childName) {
            errors.push("Child name is required.");
        }

        if (!values.relationship) {
            errors.push("Relationship is required.");
        }

        if (errors.length > 0) {
            return res.status(400).render("parent-child-request", {
                errors,
                values
            });
        }

        await ensureParentProfileForUser(req.parentUser);
        const result = await createParentChildLinkRequest(req.parentUser.id, values);

        if (result.tooManyPending) {
            return res.status(400).render("parent-child-request", {
                errors: [`You already have ${maxPendingChildLinkRequests} requests waiting for approval. Please wait for those to be reviewed, or contact us directly.`],
                values
            });
        }

        res.redirect("/parents?requested=1");
    }));

    router.get("/parents/refunds/new", requireParent, asyncHandler(async (req, res) => {
        const refundable = await getRefundableAttendanceForParent(req.parentUser.id, cleanString(req.query.attendanceId));

        res.status(refundable.error ? 400 : 200).render("parent-refund-request", {
            errors: refundable.error ? [refundable.error] : [],
            refundable,
            classDateLabel: refundable.record ? formatFriendlyDate(refundable.record.classDate) : "",
            values: { reason: "" }
        });
    }));

    router.post("/parents/refunds", refundRequestRateLimiter, requireParent, asyncHandler(async (req, res) => {
        const reason = cleanString(req.body.reason).slice(0, inputLimits.refundReason);
        const refundable = await getRefundableAttendanceForParent(req.parentUser.id, cleanString(req.body.attendanceId));
        const errors = refundable.error ? [refundable.error] : [];

        if (!refundable.error && !reason) {
            errors.push("Please tell us why you're asking for a refund.");
        }

        const classDateLabel = refundable.record ? formatFriendlyDate(refundable.record.classDate) : "";

        if (errors.length > 0) {
            return res.status(400).render("parent-refund-request", {
                errors,
                refundable,
                classDateLabel,
                values: { reason }
            });
        }

        const profile = await ensureParentProfileForUser(req.parentUser);

        try {
            await createRefundRequest({
                attendanceId: refundable.record.id,
                studentId: refundable.student.id,
                parentId: req.parentUser.id,
                reason
            });
        } catch (error) {
            if (error.code !== "23505") {
                throw error;
            }

            return res.status(400).render("parent-refund-request", {
                errors: [refundAlreadyRequestedMessage],
                refundable: { error: refundAlreadyRequestedMessage },
                classDateLabel: "",
                values: { reason }
            });
        }

        sendAdminNotification(
            `Refund request: ${refundable.student.name} (${classDateLabel})`,
            [
                `${profile.fullName || "A parent"} (${profile.email || req.parentUser.email || "no email"}) has asked for a lesson credit refund.`,
                "",
                `Student: ${refundable.student.name}`,
                `Missed class: ${classDateLabel}`,
                `Reason: ${reason}`,
                "",
                `Review it here: ${getPublicSiteOrigin()}/admin/refund-requests`
            ].join("\n")
        );

        res.redirect("/parents?refundRequested=1");
    }));

    return router;
}
