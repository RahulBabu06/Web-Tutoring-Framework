import express from "express";
import { join } from "path";
import ejs from "ejs";

import {
    bookingEmailAddress,
    adminNotificationEmail,
    gmailOAuth,
    backupPageSize,
    adminCookieName,
    supabaseUrl,
    supabaseAdminKey,
    supabaseAnonKey,
    supabaseRequestTimeoutMs,
    inputLimits,
    rootDir,
    business
} from "./config/env.js";
import {
    classOptions,
    groupClasses,
    StudentStatus,
    LinkStatus,
    RefundStatus,
    PaymentStatus,
    paymentStatuses,
    AttendanceStatus
} from "./config/classes.js";
import { createGmailClient } from "./integrations/gmail.js";
import { createSupabaseClient, inFilter } from "./integrations/supabase.js";
import { createStripeClient } from "./integrations/stripe.js";
import { createPublicRouter } from "./routes/public.js";
import { createBookingRouter } from "./routes/booking.js";
import { createParentAuthRouter } from "./routes/parent-auth.js";
import { createParentsRouter } from "./routes/parents.js";
import { createAdminRouter } from "./routes/admin.js";
import { createAdminParentsRouter } from "./routes/admin-parents.js";
import { createAdminAttendanceRouter } from "./routes/admin-attendance.js";
import { createAdminStudentsRouter } from "./routes/admin-students.js";
import { createAdminBackupsRouter } from "./routes/admin-backups.js";
import { createBookingService } from "./services/booking-service.js";
import { createBackupService } from "./services/backup-service.js";
import { createParentEmailService } from "./services/parent-email-service.js";
import { createPaymentService } from "./services/payment-service.js";
import { createAttendanceService } from "./services/attendance-service.js";
import { createRefundService } from "./services/refund-service.js";
import { createParentLinkService } from "./services/parent-link-service.js";
import { createStudentService } from "./services/student-service.js";
import { createParentService } from "./services/parent-service.js";
import { createSessionHelpers } from "./middleware/sessions.js";
import { createAuthMiddleware } from "./middleware/auth.js";
import { errorHandler } from "./middleware/errors.js";

import { csrfProtection, formBodyParser, securityHeaders } from "./middleware/security.js";

const app = express();
app.set("trust proxy", 1);
const { isConfigured: isGmailConfigured, sendEmail } = createGmailClient({ senderAddress: bookingEmailAddress, oauth: gmailOAuth });
const {
    isConfigured: isSupabaseConfigured,
    isAuthConfigured: isParentAuthConfigured,
    request: supabaseRequest,
    listAllRows,
    getRowById,
    authRequest: supabaseAuthRequest
} = createSupabaseClient({
    url: supabaseUrl,
    adminKey: supabaseAdminKey,
    anonKey: supabaseAnonKey,
    timeoutMs: supabaseRequestTimeoutMs,
    pageSize: backupPageSize
});
const {
    setParentSessionCookies,
    clearParentSessionCookies,
    getParentSession,
    parseCookies,
    isAdminPasswordCorrect,
    adminCookieOptions,
    createAdminToken,
    isValidAdminToken,
    revokeAdminToken
} = createSessionHelpers({
    supabaseAuthRequest
});

app.locals.inputLimits = inputLimits;
app.locals.business = business;
app.locals.isEmailConfigured = isGmailConfigured;
app.locals.groupClasses = groupClasses;
app.locals.classOptions = classOptions;

app.set("view engine", "ejs");
app.set("views", join(rootDir, "views"));
app.use(securityHeaders);
app.post("/stripe/webhook", express.raw({ type: "application/json", limit: "1mb" }), (req, res, next) => {
    handleStripeWebhook(req, res).catch(next);
});
app.use(csrfProtection);
app.use(express.static("public", { redirect: false }))
app.use(formBodyParser);

const maxPendingChildLinkRequests = 5;
const pendingChildLinkCapErrorCode = "WT001";

const stripeSecretKey = process.env.STRIPE_SECRET_KEY || "";
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET || "";
const lessonPackCredits = business.lessonPack.credits;
const lessonPackPricePence = business.lessonPack.priceMinorUnits;
const isStripeConfigured = Boolean(stripeSecretKey);
const { request: stripeRequest, verifySignature: verifyStripeSignature } = createStripeClient({
    secretKey: stripeSecretKey,
    webhookSecret: stripeWebhookSecret
});
// Existing checkouts are still processed when the price is invalid; only new purchases stop.
const isLessonPackForSale = isStripeConfigured && lessonPackPricePence >= 30;

if (isStripeConfigured && !isLessonPackForSale) {
    console.error("The lesson pack price (lessonPack.priceMinorUnits / LESSON_PACK_PRICE_PENCE) must be at least 30; new online payments are disabled.");
}

// Single 1-1 lessons are recorded as payments only: they add no group class credits or free skips.
const oneToOneLessons = Object.fromEntries(business.oneToOne.enabled
    ? business.oneToOne.lessons.map((lesson) => [lesson.minutes, lesson])
    : []);

Object.values(oneToOneLessons).forEach((lesson) => {
    if (isStripeConfigured && lesson.pricePence < 30) {
        console.error(`ONE_TO_ONE_${lesson.minutes}_PRICE_PENCE must be at least 30; online payment for that 1-1 lesson is disabled.`);
    }
});

function getOneToOneLesson(minutes) {
    return Object.hasOwn(oneToOneLessons, String(minutes)) ? oneToOneLessons[minutes] : null;
}

function isOneToOneLessonForSale(lesson) {
    return isStripeConfigured && lesson.pricePence >= 30;
}

function getOneToOneLessonLabel(payment) {
    if (payment.creditsPurchased > 0) {
        return "";
    }

    return Object.values(oneToOneLessons).map((lesson) => lesson.label).find((label) => payment.notes.startsWith(label)) || "";
}

async function handleStripeWebhook(req, res) {
    if (!isStripeConfigured || !stripeWebhookSecret) {
        return res.status(503).send("Stripe is not configured.");
    }

    if (!Buffer.isBuffer(req.body) || !verifyStripeSignature(req.body, req.get("stripe-signature"))) {
        return res.status(400).send("Invalid signature.");
    }

    const event = JSON.parse(req.body.toString("utf8"));
    const sessionId = String(event.data?.object?.id || "");

    if (["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(event.type)
        && /^cs_[A-Za-z0-9_]+$/.test(sessionId)) {
        // Re-read the session from Stripe so only Stripe's own record can grant credits.
        await recordStripeCheckoutPayment(await stripeRequest(`/checkout/sessions/${sessionId}`), { retryFailedNotification: true });
    }

    res.json({ received: true });
}

function normalizeStudentInput(body) {
    return {
        name: (body.name || "").trim(),
        parentName: (body.parentName || "").trim(),
        parentEmail: (body.parentEmail || "").trim(),
        phone: (body.phone || "").trim(),
        preferredClass: (body.preferredClass || "").trim(),
        credits: toInteger(body.credits),
        status: body.status === StudentStatus.inactive ? StudentStatus.inactive : StudentStatus.active,
        notes: (body.notes || "").trim()
    };
}

function normalizeParentProfileInput(body) {
    return {
        fullName: cleanString(body.fullName),
        email: cleanString(body.email).toLowerCase(),
        phone: cleanString(body.phone),
        password: String(body.password || ""),
        confirmPassword: String(body.confirmPassword || "")
    };
}

function normalizeParentLoginInput(body) {
    return {
        email: cleanString(body.email).toLowerCase(),
        password: String(body.password || "")
    };
}

function normalizeChildLinkRequestInput(body) {
    return {
        childName: cleanString(body.childName).slice(0, inputLimits.childName),
        relationship: cleanString(body.relationship).slice(0, inputLimits.childRelationship),
        notes: cleanString(body.notes).slice(0, inputLimits.childLinkNotes)
    };
}

function friendlyAuthError(error, fallback) {
    const message = error.message || "";

    if (isMissingAdminSchema(error)) {
        return "The account database is not ready yet. Ask the site administrator to finish the setup.";
    }

    if (message.includes("Invalid login credentials")) {
        return "Email or password incorrect.";
    }

    if (message.includes("User already registered") || message.includes("already been registered")) {
        return "An account already exists for that email address. Try logging in instead.";
    }

    if (message.includes("Email not confirmed")) {
        return "Please confirm your email address before logging in.";
    }

    if (message.includes("email rate limit exceeded") || message.includes("over_email_send_rate_limit")) {
        return "Email confirmation is temporarily rate-limited. Please wait a few minutes, then try again.";
    }

    if (message.includes("Signup is disabled")) {
        return "New account signups are currently disabled.";
    }

    if (message.includes("Database error")) {
        return "The account service could not finish creating the account. Please try again later.";
    }

    return fallback;
}

const adminNavSections = [
    { href: "/admin", label: "Home", matches: (path) => path === "/admin" || path === "/admin/" },
    { href: "/admin/classes", label: groupClasses.length === 1 ? groupClasses[0].name : "Classes", matches: (path) => path.startsWith("/admin/classes") },
    { href: "/admin/booking-requests", label: "Bookings", matches: (path) => path.startsWith("/admin/booking-requests") },
    { href: "/admin/students", label: "Students", matches: (path) => path.startsWith("/admin/students") },
    { href: "/admin/parent-links", label: "Parent links", countKey: "parentLinks", matches: (path) => path.startsWith("/admin/parent-links") },
    { href: "/admin/refund-requests", label: "Refunds", countKey: "refunds", matches: (path) => path.startsWith("/admin/refund-requests") },
    { href: "/admin/backup", label: "Backup", matches: (path) => path.startsWith("/admin/backup") }
];

async function countPendingRows(table, pendingStatus) {
    try {
        const { rows, total } = await supabaseRequest(`/${table}?select=id&status=eq.${pendingStatus}&limit=1`, { withCount: true });
        return total ?? rows.length;
    } catch (error) {
        if (!isMissingAdminSchema(error)) {
            console.error("Pending count failed:", table, error.message);
        }

        return 0;
    }
}

async function loadAdminPendingCounts() {
    if (!isSupabaseConfigured) {
        return { parentLinks: 0, refunds: 0 };
    }

    const [parentLinks, refunds] = await Promise.all([
        countPendingRows("parent_student_links", LinkStatus.pending),
        countPendingRows("attendance_refund_requests", RefundStatus.pending)
    ]);

    return { parentLinks, refunds };
}

function setAdminNavLinks(res, path, counts = {}) {
    res.locals.adminNavLinks = adminNavSections.map((section) => ({
        href: section.href,
        label: section.label,
        active: section.matches(path),
        count: section.countKey ? counts[section.countKey] || 0 : 0
    }));
}

const { requireAdmin, requireParent } = createAuthMiddleware({
    isAdminRequest: (req) => isValidAdminToken(parseCookies(req)[adminCookieName]),
    loadAdminPendingCounts,
    setAdminNavLinks,
    getParentSession
});

function asyncHandler(handler) {
    return (req, res, next) => {
        Promise.resolve(handler(req, res, next)).catch(next);
    };
}

// PostgREST/Postgres codes for a table, column or function that doesn't exist (yet).
const missingSchemaErrorCodes = new Set(["PGRST200", "PGRST202", "PGRST204", "PGRST205", "42P01", "42703"]);
const adminSchemaNames = [
    "admin_students",
    "admin_attendance",
    "admin_payments",
    "parent_profiles",
    "attendance_refund_requests",
    "parent_student_links",
    "record_admin_payment",
    "save_attendance_register",
    "refund_charged_absence",
    "approve_refund_request",
    "credits",
    "amount_pence"
];

function isMissingAdminSchema(error, schemaNames = adminSchemaNames) {
    const message = error?.message || "";
    return missingSchemaErrorCodes.has(error?.code) && schemaNames.some((name) => message.includes(name));
}

const refundSchemaUpdateMessage = "Refund not applied: the database needs updating. Run supabase/schema.sql in the Supabase SQL editor, then try again.";
const setupIncompleteMessage = "The database setup is incomplete. Ask the site administrator to finish the setup.";
const setupIncompleteRefreshMessage = "The database setup is incomplete. Ask the site administrator to finish the setup, then refresh this page.";

async function loadAdminData(loader, message = setupIncompleteRefreshMessage) {
    if (!isSupabaseConfigured) {
        return "";
    }

    try {
        await loader();
        return "";
    } catch (error) {
        if (!isMissingAdminSchema(error)) {
            throw error;
        }

        return message;
    }
}

function isUuid(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
}

function cleanString(value) {
    return typeof value === "string" ? value.trim() : "";
}

function toInteger(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

function moneyToPence(value) {
    const normalizedValue = cleanString(value).replace(/[^\d.-]/g, "");
    const number = Number(normalizedValue);
    return Number.isFinite(number) ? Math.round(number * 100) : 0;
}

function formatMoney(amountPence, currency = business.currency) {
    return new Intl.NumberFormat(business.locale, {
        style: "currency",
        currency
    }).format(toInteger(amountPence) / 100);
}

function formatPaymentDateInput(value) {
    if (isDateInput(value)) {
        return value;
    }

    return formatDateInput(new Date());
}

function paymentDateToIso(value) {
    return `${formatPaymentDateInput(value)}T12:00:00.000Z`;
}

function cleanDisplayNotes(notes) {
    return cleanString(notes)
        .split("\n")
        .filter((line) => !/^Imported (batch|credits|old ID):/i.test(line.trim()))
        .join("\n")
        .trim();
}

function legacyImportedCredits(notes) {
    const match = cleanString(notes).match(/^Imported credits:\s*(-?\d+)/im);
    return match ? toInteger(match[1]) : null;
}

function formatDateInput(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

function getDateInputWeekday(dateInput) {
    return new Date(`${dateInput}T12:00:00Z`).getUTCDay();
}

// Most recent date (today or earlier) the class meets on.
function getDefaultClassDate(groupClass) {
    const today = getLocalNow().date;
    return addDaysToDateInput(today, -((getDateInputWeekday(today) - groupClass.weekday + 7) % 7));
}

// Next date (today or later) the class meets on.
function getNextClassDate(groupClass) {
    const today = getLocalNow().date;
    return addDaysToDateInput(today, (groupClass.weekday - getDateInputWeekday(today) + 7) % 7);
}

function isDateInput(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function normalizeClassDate(value, groupClass = groupClasses[0]) {
    if (isDateInput(value)) {
        return value;
    }

    return groupClass ? getDefaultClassDate(groupClass) : getLocalNow().date;
}

function formatClassDateLabel(value) {
    return new Date(`${value}T00:00:00`).toLocaleDateString(business.locale, {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric"
    });
}

function toStudentView(row) {
    const notes = row.notes || "";
    const storedCredits = toInteger(row.credits);
    const legacyCredits = legacyImportedCredits(notes);

    return {
        id: row.id,
        name: row.name || "",
        parentName: row.parent_name || "",
        parentEmail: row.parent_email || "",
        phone: row.phone || "",
        preferredClass: row.preferred_class || "",
        credits: storedCredits === 0 && legacyCredits !== null ? legacyCredits : storedCredits,
        status: row.status || StudentStatus.active,
        notes,
        displayNotes: cleanDisplayNotes(notes),
        createdAt: row.created_at || "",
        updatedAt: row.updated_at || ""
    };
}

function toStudentRow(studentInput) {
    return {
        name: studentInput.name,
        parent_name: studentInput.parentName || null,
        parent_email: studentInput.parentEmail || null,
        phone: studentInput.phone || null,
        preferred_class: studentInput.preferredClass || null,
        credits: toInteger(studentInput.credits),
        status: studentInput.status,
        notes: studentInput.notes || null
    };
}

function chunkRows(rows, size) {
    const chunks = [];

    for (let index = 0; index < rows.length; index += size) {
        chunks.push(rows.slice(index, index + size));
    }

    return chunks;
}

async function upsertInChunks(path, rows, size = 100) {
    const savedRows = [];

    for (const chunk of chunkRows(rows, size)) {
        const chunkSavedRows = await supabaseRequest(path, {
            method: "POST",
            headers: {
                Prefer: "resolution=merge-duplicates,return=representation"
            },
            body: JSON.stringify(chunk)
        });
        savedRows.push(...chunkSavedRows);
    }

    return savedRows;
}

async function listStudents() {
    const rows = await supabaseRequest("/admin_students?select=*&order=name.asc");
    return rows.map(toStudentView);
}

async function listGroupClassStudents(groupClass) {
    const preferredClass = encodeURIComponent(groupClass.option);
    const rows = await supabaseRequest(`/admin_students?select=*&preferred_class=eq.${preferredClass}&status=eq.${StudentStatus.active}&order=name.asc`);
    return rows.map(toStudentView);
}

const attendanceChargeLabels = {
    attended: "Attended",
    free_skip: "Free skip",
    charged: "Charged absence",
    waived: "Charge waived"
};
const attendanceChargeTypes = Object.keys(attendanceChargeLabels);
const { initialFreeSkips, freeSkipsPerPaidBlock, paidCreditsPerBlock, maxFreeSkipsHeld, lowCreditThreshold } = business.attendance;

function normalizeAttendanceStatus(status) {
    return status === AttendanceStatus.absent ? AttendanceStatus.absent : AttendanceStatus.present;
}

function inferChargeType(row) {
    if (row.status !== AttendanceStatus.absent) {
        return "attended";
    }

    return toInteger(row.credit_delta) < 0 ? "charged" : "free_skip";
}

// A missed class that used a credit, so it can be refunded.
function isChargedAbsence(record) {
    return record.status === AttendanceStatus.absent && record.creditDelta < 0;
}

// Every student starts with initialFreeSkips and gets freeSkipsPerPaidBlock more for each complete
// paidCreditsPerBlock credits paid for, but holds at most maxFreeSkipsHeld: extra skips are lost, not carried over.
// Waivers and refunds restore credits but aren't payments, so they never add skips.
// Rows saved before free skips launched have no charge_type and are ignored.
// Only skips before classDate and payments up to classDate count; a payment on a class date comes before that class.
function getFreeSkipsLeft(history, payments, classDate) {
    const events = [
        ...payments
            .filter((payment) => payment.status === PaymentStatus.paid && payment.paidDate <= classDate)
            .map((payment) => ({ date: payment.paidDate, order: 0, credits: Math.max(0, payment.creditsPurchased) })),
        ...history
            .filter((record) => record.chargeTypeRecorded && record.chargeType === "free_skip" && record.classDate < classDate)
            .map((record) => ({ date: record.classDate, order: 1 }))
    ].sort((a, b) => a.date.localeCompare(b.date) || a.order - b.order);

    let paidCredits = 0;
    let skipsLeft = initialFreeSkips;

    events.forEach((event) => {
        if (event.order === 1) {
            skipsLeft = Math.max(0, skipsLeft - 1);
            return;
        }

        const blocksBefore = Math.floor(paidCredits / paidCreditsPerBlock);
        paidCredits += event.credits;
        skipsLeft = Math.min(maxFreeSkipsHeld, skipsLeft + freeSkipsPerPaidBlock * (Math.floor(paidCredits / paidCreditsPerBlock) - blocksBefore));
    });

    return skipsLeft;
}

function toAttendanceView(row) {
    const chargeType = attendanceChargeTypes.includes(row.charge_type) ? row.charge_type : inferChargeType(row);

    return {
        id: row.id,
        studentId: row.student_id,
        classDate: row.class_date,
        status: row.status,
        creditDelta: toInteger(row.credit_delta),
        chargeType,
        chargeLabel: attendanceChargeLabels[chargeType],
        chargeTypeRecorded: attendanceChargeTypes.includes(row.charge_type),
        notes: row.notes || "",
        createdAt: row.created_at || "",
        updatedAt: row.updated_at || ""
    };
}

function normalizePaymentInput(body) {
    const status = paymentStatuses.includes(body.status) ? body.status : PaymentStatus.paid;
    const provider = cleanString(body.provider) || "manual";

    return {
        amountPence: moneyToPence(body.amount),
        currency: (cleanString(body.currency) || business.currency).toUpperCase(),
        status,
        provider,
        paymentMethod: cleanString(body.paymentMethod) || (provider === "manual" ? "manual" : provider),
        providerPaymentId: cleanString(body.providerPaymentId),
        providerCheckoutSessionId: cleanString(body.providerCheckoutSessionId),
        creditsPurchased: toInteger(body.creditsPurchased),
        paidAt: paymentDateToIso(body.paidAt),
        notes: cleanString(body.notes)
    };
}

function toPaymentView(row) {
    return {
        id: row.id,
        studentId: row.student_id,
        amountPence: toInteger(row.amount_pence),
        amount: formatMoney(row.amount_pence, row.currency || business.currency),
        currency: row.currency || business.currency,
        status: row.status || PaymentStatus.paid,
        provider: row.provider || "manual",
        paymentMethod: row.payment_method || "manual",
        providerPaymentId: row.provider_payment_id || "",
        providerCheckoutSessionId: row.provider_checkout_session_id || "",
        creditsPurchased: toInteger(row.credits_purchased),
        paidAt: row.paid_at || "",
        paidDate: row.paid_at ? row.paid_at.slice(0, 10) : "",
        notes: row.notes || "",
        createdAt: row.created_at || "",
        updatedAt: row.updated_at || ""
    };
}

function toParentProfileView(row) {
    return {
        id: row.id,
        email: row.email || "",
        fullName: row.full_name || "",
        phone: row.phone || "",
        createdAt: row.created_at || "",
        updatedAt: row.updated_at || ""
    };
}

function toParentLinkView(row, parent = null, student = null) {
    return {
        id: row.id,
        parentId: row.parent_id,
        studentId: row.student_id || "",
        requestedChildName: row.requested_child_name || "",
        relationship: row.relationship || "",
        status: row.status || LinkStatus.pending,
        notes: row.notes || "",
        reviewedNotes: row.reviewed_notes || "",
        requestedAt: row.requested_at || row.created_at || "",
        reviewedAt: row.reviewed_at || "",
        parent,
        student,
        createdAt: row.created_at || "",
        updatedAt: row.updated_at || ""
    };
}

const friendlyDateFormatter = new Intl.DateTimeFormat(business.locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: business.timeZone
});

function formatFriendlyDate(value) {
    if (!value) {
        return "";
    }

    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : friendlyDateFormatter.format(date);
}

function pluralizeLessons(count) {
    return `${count} lesson${count === 1 ? "" : "s"}`;
}

function describeCreditChange(delta) {
    if (delta < 0) {
        return `${pluralizeLessons(-delta)} used`;
    }

    return delta > 0 ? `${pluralizeLessons(delta)} added` : "No lesson used";
}

function toParentAttendanceView(record) {
    return {
        id: record.id,
        classDate: record.classDate,
        dateLabel: formatFriendlyDate(record.classDate),
        status: record.status,
        chargeType: record.chargeType,
        creditDelta: record.creditDelta,
        creditLabel: {
            free_skip: "Free skip, no lesson used",
            waived: "Charge waived, no lesson used",
            charged: "Missed class, 1 lesson used"
        }[record.chargeType] || describeCreditChange(record.creditDelta)
    };
}

function toParentPaymentView(payment) {
    return {
        id: payment.id,
        amount: payment.amount,
        status: payment.status,
        creditsPurchased: payment.creditsPurchased,
        creditsLabel: payment.creditsPurchased > 0 ? `${pluralizeLessons(payment.creditsPurchased)} added` : getOneToOneLessonLabel(payment),
        paidDate: payment.paidDate,
        paidDateLabel: formatFriendlyDate(payment.paidDate),
        paymentMethod: payment.paymentMethod,
        notes: payment.notes
    };
}

const adminReviewQueueLimit = 200;
const adminReviewHistoryLimit = 100;
async function listAttendanceForDate(classDate) {
    const rows = await supabaseRequest(`/admin_attendance?select=*&class_date=eq.${encodeURIComponent(classDate)}`);
    return rows.map(toAttendanceView);
}

async function listAttendanceHistory(studentId) {
    const rows = await supabaseRequest(`/admin_attendance?select=*&student_id=eq.${encodeURIComponent(studentId)}&order=class_date.desc`);
    return rows.map(toAttendanceView);
}

async function listAttendanceForStudents(studentIds, order = "class_date.asc") {
    if (studentIds.length === 0) {
        return [];
    }

    const rows = await listAllRows("admin_attendance", order, `student_id=${inFilter(studentIds)}`);
    return rows.map(toAttendanceView);
}

async function getAttendanceRecord(attendanceId) {
    return getRowById("admin_attendance", attendanceId, toAttendanceView);
}

// The waive and the credit are one conditional database transaction, so a refund applies at most once.
async function deliverAdminNotification(subject, text) {
    if (!isGmailConfigured) {
        console.warn(`Gmail API is not configured; admin notification not sent: ${subject}`);
        return;
    }

    await sendEmail({
        to: adminNotificationEmail,
        subject: subject.replace(/[\r\n]+/g, " "),
        text
    });
}

function sendAdminNotification(subject, text) {
    deliverAdminNotification(subject, text).catch((error) => console.error("Admin notification email failed:", error.message));
}

const parentEmailsEnabled = process.env.PARENT_EMAILS !== "off";

function getPublicSiteOrigin() {
    return business.siteUrl;
}

function isEmailAddress(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value || "");
}

function getLocalNow(date = new Date()) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
        timeZone: business.timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        weekday: "short",
        hourCycle: "h23"
    }).formatToParts(date).map((part) => [part.type, part.value]));

    return {
        date: `${parts.year}-${parts.month}-${parts.day}`,
        weekday: parts.weekday,
        hour: Number(parts.hour)
    };
}

function addDaysToDateInput(value, days) {
    const date = new Date(`${value}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
}

const {
    listStudentPayments,
    listPaymentsForStudents,
    getStudent,
    listStudentsByIds,
    createStudent,
    updateStudent,
    bulkUpdateStudents
} = createStudentService({
    getRowById,
    listAllRows,
    supabaseRequest,
    toPaymentView,
    toStudentRow,
    toStudentView
});

const {
    signUpParentAccount,
    signInParentAccount,
    sendParentPasswordReset,
    updateParentPassword,
    signOutParentAccount,
    ensureParentProfileForUser,
    listParentLinks,
    normalizeChildName,
    parentHasApprovedLink,
    getParentLink,
    findUniqueStudentByName,
    createParentChildLinkRequest,
    listParentDashboardChildren
} = createParentService({
    formatFriendlyDate,
    getFreeSkipsLeft,
    getRowById,
    listAttendanceForStudents,
    listPaymentsForStudents,
    // Refund service is created later and depends on this one.
    listRefundRequestsForParent: (...args) => listRefundRequestsForParent(...args),
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
});

const {
    BackupImportError,
    ensureBackupDirectory,
    importBackupStudents,
    backupPayload
} = createBackupService({
    attendanceChargeTypes,
    cleanDisplayNotes,
    cleanString,
    isDateInput,
    isUuid,
    listAllRows,
    normalizeAttendanceStatus,
    normalizeClassDate,
    supabaseRequest,
    toAttendanceView,
    toInteger,
    toPaymentView,
    toStudentRow,
    toStudentView
});

const {
    queueParentEmails,
    classDateJobKey,
    runForClassDate,
    sendPaymentReceipt,
    sendAttendanceEmails,
    getClassCancellation,
    cancelClass,
    restoreClass,
    sendCancellationEmails,
    sendClassRestoredEmails,
    runParentReminders
} = createParentEmailService({
    addDaysToDateInput,
    chunkRows,
    formatClassDateLabel,
    getLocalNow,
    getOneToOneLessonLabel,
    getPublicSiteOrigin,
    getStudent,
    isEmailAddress,
    isGmailConfigured,
    isMissingAdminSchema,
    isSupabaseConfigured,
    listPaymentsForStudents,
    listStudents,
    listGroupClassStudents,
    lowCreditThreshold,
    parentEmailsEnabled,
    pluralizeLessons,
    sendEmail,
    supabaseRequest,
    toStudentView
});

const {
    recordPayment,
    recordStripeCheckoutPayment
} = createPaymentService({
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
});

const {
    saveClassRegister,
    loadClassDateStatus
} = createAttendanceService({
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
});

const {
    refundChargedAbsence,
    approveRefundRequest,
    listRefundRequestsForParent,
    getRefundRequest,
    createRefundRequest,
    reviewRefundRequest,
    listAdminRefundRequests,
    refundAlreadyRequestedMessage,
    getRefundableAttendanceForParent
} = createRefundService({
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
});

const {
    listAdminParentLinkRequests,
    reviewParentLinkRequest,
    unlinkParentLink
} = createParentLinkService({
    adminReviewHistoryLimit,
    adminReviewQueueLimit,
    findUniqueStudentByName,
    getParentLink,
    getStudent,
    normalizeChildName,
    supabaseRequest,
    toParentLinkView,
    toParentProfileView
});

app.use(createPublicRouter({ formatMoney, isLessonPackForSale: lessonPackPricePence > 0, lessonPackCredits, lessonPackPricePence }));

app.use(createParentAuthRouter({
    asyncHandler,
    requireParent,
    isParentAuthConfigured,
    getParentSession,
    setParentSessionCookies,
    clearParentSessionCookies,
    normalizeParentLoginInput,
    normalizeParentProfileInput,
    cleanString,
    friendlyAuthError,
    getPublicSiteOrigin,
    signInParentAccount,
    signUpParentAccount,
    sendParentPasswordReset,
    updateParentPassword,
    signOutParentAccount
}));

app.use(createParentsRouter({
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
}));

app.use(createAdminRouter({
    adminCookieOptions,
    asyncHandler,
    createAdminToken,
    getDefaultClassDate,
    getNextClassDate,
    isAdminPasswordCorrect,
    isSupabaseConfigured,
    listStudents,
    loadAdminData,
    loadClassDateStatus,
    lowCreditThreshold,
    parseCookies,
    requireAdmin,
    revokeAdminToken
}));

app.use(createAdminParentsRouter({
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
}));

app.use(createAdminAttendanceRouter({
    asyncHandler,
    cancelClass,
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
    classDateJobKey,
    saveClassRegister,
    sendAttendanceEmails,
    sendCancellationEmails,
    sendClassRestoredEmails
}));

app.use(createAdminStudentsRouter({
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
}));

app.use(createAdminBackupsRouter({
    BackupImportError,
    adminSchemaNames,
    asyncHandler,
    backupPayload,
    cleanString,
    ensureBackupDirectory,
    importBackupStudents,
    isMissingAdminSchema,
    isSupabaseConfigured,
    requireAdmin,
    setupIncompleteMessage
}));

app.use(createBookingRouter({
    requireAdmin,
    bookingService: createBookingService({
        email: { isConfigured: isGmailConfigured, sendEmail },
        bookingEmailAddress,
        getOneToOneLesson,
        formatMoney
    })
}));

app.use(errorHandler);

export default app;
export { runParentReminders };
