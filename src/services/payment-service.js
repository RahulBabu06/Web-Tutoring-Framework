import { PaymentStatus } from "../config/classes.js";
import { business } from "../config/env.js";

export function createPaymentService({
    deliverAdminNotification,
    formatMoney,
    getOneToOneLesson,
    getStudent,
    isUuid,
    pluralizeLessons,
    queueParentEmails,
    sendAdminNotification,
    sendPaymentReceipt,
    stripeRequest,
    supabaseRequest,
    toInteger,
    toPaymentView
}) {
    async function recordPayment(student, paymentInput) {
        const payment = await supabaseRequest("/rpc/record_admin_payment", {
            method: "POST",
            body: JSON.stringify({
                p_student_id: student.id,
                p_amount_pence: paymentInput.amountPence,
                p_currency: paymentInput.currency,
                p_status: paymentInput.status,
                p_provider: paymentInput.provider,
                p_payment_method: paymentInput.paymentMethod,
                p_provider_payment_id: paymentInput.providerPaymentId || null,
                p_provider_checkout_session_id: paymentInput.providerCheckoutSessionId || null,
                p_credits_purchased: paymentInput.creditsPurchased,
                p_paid_at: paymentInput.paidAt,
                p_notes: paymentInput.notes || null
            })
        });
        return toPaymentView(payment);
    }

    const stripePaymentNote = "Paid online by parent via Stripe Checkout";
    const adminNotifiedSuffix = "; admin notified";

    // Only one concurrent caller can flip the note, so the admin is emailed once per payment.
    async function claimStripePaymentNotification(paymentId, note) {
        const rows = await supabaseRequest(`/admin_payments?id=eq.${encodeURIComponent(paymentId)}&notes=eq.${encodeURIComponent(note)}`, {
            method: "PATCH",
            headers: {
                Prefer: "return=representation"
            },
            body: JSON.stringify({ notes: `${note}${adminNotifiedSuffix}` })
        });
        return rows.length > 0;
    }

    async function releaseStripePaymentNotification(paymentId, note) {
        await supabaseRequest(`/admin_payments?id=eq.${encodeURIComponent(paymentId)}&notes=eq.${encodeURIComponent(`${note}${adminNotifiedSuffix}`)}`, {
            method: "PATCH",
            body: JSON.stringify({ notes: note })
        });
    }

    const alertedMissingStudentSessions = new Set();

    // Safe to call more than once per session: record_admin_payment ignores a repeated checkout session ID.
    async function recordStripeCheckoutPayment(session, { retryFailedNotification = false } = {}) {
        const studentId = session.metadata?.student_id;
        const oneToOneLesson = getOneToOneLesson(session.metadata?.one_to_one_minutes);
        const credits = oneToOneLesson ? 0 : toInteger(session.metadata?.credits);
        const purchaseLabel = oneToOneLesson ? `a ${oneToOneLesson.label}` : pluralizeLessons(credits);
        const paymentNote = oneToOneLesson ? `${oneToOneLesson.label}. ${stripePaymentNote}` : stripePaymentNote;

        if (session.payment_status !== "paid" || !isUuid(studentId) || (credits <= 0 && !oneToOneLesson)) {
            return null;
        }

        const student = await getStudent(studentId);

        if (!student) {
            if (session.metadata?.missing_student_alerted || alertedMissingStudentSessions.has(session.id)) {
                return null;
            }

            alertedMissingStudentSessions.add(session.id);
            console.error(`Paid Stripe checkout ${session.id} has no matching student ${studentId}.`);
            sendAdminNotification(
                "Online payment needs attention",
                `A parent paid ${formatMoney(session.amount_total, (session.currency || business.currency).toUpperCase())} online for ${purchaseLabel}, `
                + `but the student (${studentId}) no longer exists, so the payment wasn't recorded.\n`
                + `Parent email: ${session.customer_details?.email || session.customer_email || "unknown"}\n`
                + `Stripe checkout session: ${session.id}\n`
                + "Refund the payment in Stripe or record it on the right student manually."
            );
            await stripeRequest(`/checkout/sessions/${session.id}`, { method: "POST", params: { "metadata[missing_student_alerted]": "true" } })
                .catch((error) => console.error("Could not mark Stripe checkout as alerted:", error.message));
            return null;
        }

        const paymentIntent = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;
        const payment = await recordPayment(student, {
            amountPence: toInteger(session.amount_total),
            currency: (session.currency || business.currency).toUpperCase(),
            status: PaymentStatus.paid,
            provider: "stripe",
            paymentMethod: "stripe_checkout",
            providerPaymentId: paymentIntent || "",
            providerCheckoutSessionId: session.id,
            creditsPurchased: credits,
            paidAt: new Date().toISOString(),
            notes: paymentNote
        });

        queueParentEmails("payment receipt", () => sendPaymentReceipt(student.id, payment));

        if (payment.id && await claimStripePaymentNotification(payment.id, paymentNote)) {
            try {
                await deliverAdminNotification(
                    `Online payment: ${student.name}`,
                    `${student.name} bought ${purchaseLabel} online for ${formatMoney(session.amount_total, payment.currency)}.\n`
                    + `Parent email: ${session.customer_details?.email || session.customer_email || "unknown"}`
                );
            } catch (error) {
                console.error("Admin notification email failed:", error.message);
                await releaseStripePaymentNotification(payment.id, paymentNote)
                    .catch((releaseError) => console.error("Could not release payment notification:", releaseError.message));

                if (retryFailedNotification) {
                    throw error;
                }
            }
        }

        return payment;
    }

    return {
        recordPayment,
        stripePaymentNote,
        adminNotifiedSuffix,
        claimStripePaymentNotification,
        releaseStripePaymentNotification,
        alertedMissingStudentSessions,
        recordStripeCheckoutPayment
    };
}
