import { LinkStatus, PaymentStatus, StudentStatus, groupClasses } from "../config/classes.js";
import { business } from "../config/env.js";
import { inFilter, quotedInFilter } from "../integrations/supabase.js";

export function createParentEmailService({
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
}) {
    const parentEmailBatchSize = 50;

    // Returns studentId -> parent emails (the student's own parent email plus approved linked parent accounts).
    async function getParentEmailsByStudent(students) {
        const emailsByStudent = new Map();

        for (const student of students) {
            if (!emailsByStudent.has(student.id)) {
                emailsByStudent.set(student.id, new Set(isEmailAddress(student.parentEmail) ? [student.parentEmail.toLowerCase()] : []));
            }
        }

        const links = [];

        for (const studentIds of chunkRows([...emailsByStudent.keys()], parentEmailBatchSize)) {
            links.push(...await supabaseRequest(`/parent_student_links?select=parent_id,student_id&student_id=${inFilter(studentIds)}&status=eq.${LinkStatus.approved}`));
        }

        const emailByParent = new Map();

        for (const parentIds of chunkRows([...new Set(links.map((link) => link.parent_id))], parentEmailBatchSize)) {
            const profiles = await supabaseRequest(`/parent_profiles?select=id,email&id=${inFilter(parentIds)}`);
            profiles.filter((profile) => isEmailAddress(profile.email)).forEach((profile) => emailByParent.set(profile.id, profile.email.toLowerCase()));
        }

        for (const link of links) {
            if (emailByParent.has(link.parent_id)) {
                emailsByStudent.get(link.student_id)?.add(emailByParent.get(link.parent_id));
            }
        }

        return new Map([...emailsByStudent].map(([studentId, emails]) => [studentId, [...emails]]));
    }

    async function listSentDedupeKeys(dedupeKeys) {
        const sent = new Set();

        for (const keys of chunkRows(dedupeKeys, parentEmailBatchSize)) {
            const rows = await supabaseRequest(`/parent_email_log?select=dedupe_key&dedupe_key=${quotedInFilter(keys)}`);
            rows.forEach((row) => sent.add(row.dedupe_key));
        }

        return sent;
    }

    // The unique dedupe_key row is written before sending, so each email goes out at most once; it is removed if sending fails.
    function getParentEmailFooter() {
        return `\n\n${business.name}\nParent portal: ${getPublicSiteOrigin()}/parents\n\n`
            + `You're getting this because your child is registered for ${business.name} classes. Reply to this email if you have any questions.`;
    }

    async function sendParentEmail({ dedupeKey, kind, studentId, to, subject, text }) {
        const rows = await supabaseRequest("/parent_email_log?on_conflict=dedupe_key", {
            method: "POST",
            headers: {
                Prefer: "resolution=ignore-duplicates,return=representation"
            },
            body: JSON.stringify({ dedupe_key: dedupeKey, kind, student_id: studentId, recipient: to })
        });

        if (!rows || rows.length === 0) {
            return false;
        }

        try {
            await sendEmail({
                to,
                subject: subject.replace(/[\r\n]+/g, " "),
                text: `${text}${getParentEmailFooter()}`
            });
            return true;
        } catch (error) {
            await supabaseRequest(`/parent_email_log?id=eq.${encodeURIComponent(rows[0].id)}`, { method: "DELETE" }).catch(() => {});
            throw error;
        }
    }

    // Sends each message ({ student, key, kind, subject, text }) to that student's parents, in order.
    // Batch jobs that repeat (reminders) skip already-logged keys up front; sendParentEmail's claim still guarantees at most once.
    async function sendToParentsBatch(messages, { skipLogged = true } = {}) {
        if (!parentEmailsEnabled || !isGmailConfigured || messages.length === 0) {
            return;
        }

        const emailsByStudent = await getParentEmailsByStudent(messages.map((message) => message.student));
        const sends = messages.flatMap(({ student, key, kind, subject, text }) => emailsByStudent.get(student.id)
            .map((email) => ({ dedupeKey: `${key}:${email}`, kind, studentId: student.id, to: email, subject, text })));
        const logged = skipLogged && sends.length > 0 ? await listSentDedupeKeys(sends.map((send) => send.dedupeKey)) : new Set();

        for (const send of sends.filter((item) => !logged.has(item.dedupeKey))) {
            await sendParentEmail(send)
                .catch((error) => console.error(`Parent email (${send.kind}) failed:`, error.message));
        }
    }

    async function sendToParents(student, message) {
        await sendToParentsBatch([{ student, ...message }], { skipLogged: false });
    }

    function queueParentEmails(label, task) {
        task().catch((error) => console.error(`Parent ${label} emails failed:`, error.message));
    }

    function classDateJobKey(groupClass, classDate) {
        return `${groupClass.id}:${classDate}`;
    }

    // Cancel, undo and their emails for one class date run one at a time, so an undo
    // only reads the email log once any cancellation emails still being sent have finished.
    const classDateJobs = new Map();

    function runForClassDate(classDate, task) {
        const job = (classDateJobs.get(classDate) || Promise.resolve()).then(task);
        const tail = job.catch(() => {});
        classDateJobs.set(classDate, tail);
        tail.then(() => {
            if (classDateJobs.get(classDate) === tail) {
                classDateJobs.delete(classDate);
            }
        });
        return job;
    }

    function getLowCreditReminder(student, payments) {
        if (student.status === StudentStatus.inactive || student.credits > lowCreditThreshold) {
            return null;
        }

        const lastPaid = payments
            .filter((payment) => payment.status === PaymentStatus.paid && payment.creditsPurchased > 0)
            .sort((a, b) => (b.paidAt || b.createdAt).localeCompare(a.paidAt || a.createdAt))[0];
        const origin = getPublicSiteOrigin();
        const balance = student.credits <= 0 ? "no lesson credits left" : `only ${pluralizeLessons(student.credits)} left`;

        return {
            student,
            key: `low_credits:${student.id}:${lastPaid ? lastPaid.id : "none"}`,
            kind: "low_credits",
            subject: `${student.name} is running low on lessons`,
            text: `${student.name} has ${balance}.\n\n`
                + `Log in to the parent portal to top up: ${origin}/parents\n`
                + `No account yet? Register at ${origin}/parents/register and ask to link ${student.name}.`
        };
    }

    async function sendPaymentReceipt(studentId, payment) {
        const oneToOneLabel = payment ? getOneToOneLessonLabel(payment) : "";

        if (!payment || payment.status !== PaymentStatus.paid || (payment.creditsPurchased <= 0 && !oneToOneLabel)) {
            return;
        }

        const student = await getStudent(studentId);

        if (!student) {
            return;
        }

        if (oneToOneLabel) {
            return sendToParents(student, {
                key: `payment:${payment.id}`,
                kind: "payment_receipt",
                subject: `Payment received: ${oneToOneLabel} for ${student.name}`,
                text: `Thank you. We've received your payment of ${payment.amount} for a ${oneToOneLabel} for ${student.name}.`
            });
        }

        await sendToParents(student, {
            key: `payment:${payment.id}`,
            kind: "payment_receipt",
            subject: `Payment received: ${pluralizeLessons(payment.creditsPurchased)} for ${student.name}`,
            text: `Thank you. We've received your payment of ${payment.amount} for ${student.name}.\n\n`
                + `Lessons added: ${payment.creditsPurchased}\n`
                + `Lesson credits now: ${student.credits}`
        });
    }

    const attendanceEmailWording = {
        attended: (notice) => `${notice.student.name} attended. Lesson credits used: ${Math.max(0, -notice.creditDelta)}.`,
        free_skip: (notice) => `${notice.student.name} was marked absent. This used a free skip, so no lesson credit was taken.`,
        charged: (notice) => `${notice.student.name} was marked absent and had no free skips left, so 1 lesson credit was taken. `
            + "If there was a good reason, you can request a refund in the parent portal.",
        waived: (notice) => `${notice.student.name} was marked absent. The charge was waived, so no lesson credit was taken.`
    };

    async function sendAttendanceEmails(groupClass, classDate, notices) {
        const label = formatClassDateLabel(classDate);

        await sendToParentsBatch(notices.flatMap((notice) => [{
            student: notice.student,
            key: `attendance:${classDate}:${notice.student.id}:${notice.chargeType}:${notice.creditDelta}`,
            kind: "attendance",
            subject: `${notice.student.name}: ${groupClass.name}, ${label}`,
            text: `${groupClass.name}, ${label}\n\n${attendanceEmailWording[notice.chargeType](notice)}\n\n`
                + `Lesson credits left: ${notice.student.credits}\n`
                + `Free skips left: ${notice.freeSkipsLeft}`
        }, getLowCreditReminder(notice.student, notice.payments)].filter(Boolean)));
    }

    async function getClassCancellation(groupClass, classDate) {
        try {
            const rows = await supabaseRequest(`/class_cancellations?select=*&class_id=eq.${encodeURIComponent(groupClass.id)}&class_date=eq.${encodeURIComponent(classDate)}&limit=1`);
            return rows[0] ? { classId: rows[0].class_id, classDate: rows[0].class_date, reason: rows[0].reason || "" } : null;
        } catch (error) {
            if (isMissingAdminSchema(error, ["class_cancellations"])) {
                return null;
            }

            throw error;
        }
    }

    function cancellationDedupeKey(groupClass, classDate, studentId) {
        return `cancelled:${groupClass.id}:${classDate}:${studentId}`;
    }

    async function cancelClass(groupClass, classDate, reason) {
        await supabaseRequest("/class_cancellations?on_conflict=class_id,class_date", {
            method: "POST",
            headers: {
                Prefer: "resolution=merge-duplicates"
            },
            body: JSON.stringify({ class_id: groupClass.id, class_date: classDate, reason: reason || null })
        });
    }

    // Returns the cancellation email log rows it deleted, so the same parents can be told the class is back on.
    async function restoreClass(groupClass, classDate) {
        await supabaseRequest(`/class_cancellations?class_id=eq.${encodeURIComponent(groupClass.id)}&class_date=eq.${encodeURIComponent(classDate)}`, { method: "DELETE" });

        try {
            return await supabaseRequest(`/parent_email_log?dedupe_key=like.${encodeURIComponent(cancellationDedupeKey(groupClass, classDate, "*"))}`, {
                method: "DELETE",
                headers: {
                    Prefer: "return=representation"
                }
            });
        } catch (error) {
            if (isMissingAdminSchema(error, ["parent_email_log"])) {
                return [];
            }

            throw error;
        }
    }

    function describeClass(groupClass) {
        return groupClass.time ? `${groupClass.name} (${groupClass.time})` : groupClass.name;
    }

    async function sendCancellationEmails(groupClass, classDate, reason) {
        const label = formatClassDateLabel(classDate);

        await sendToParentsBatch((await listGroupClassStudents(groupClass)).map((student) => ({
            student,
            key: cancellationDedupeKey(groupClass, classDate, student.id),
            kind: "class_cancelled",
            subject: `Class cancelled: ${label}`,
            text: `The ${describeClass(groupClass)} on ${label} is cancelled.${reason ? `\nReason: ${reason}` : ""}\n\n`
                + `No lesson credit or free skip will be used for ${student.name}. See you at the next class.`
        })));
    }

    async function sendClassRestoredEmails(groupClass, classDate, logRows) {
        const label = formatClassDateLabel(classDate);
        const studentIds = [...new Set(logRows.map((row) => row.student_id).filter(Boolean))];
        const students = [];

        for (const ids of chunkRows(studentIds, parentEmailBatchSize)) {
            students.push(...(await supabaseRequest(`/admin_students?select=*&id=${inFilter(ids)}`)).map(toStudentView));
        }

        const currentEmailsByStudent = await getParentEmailsByStudent(students);

        // Only parents who still get this child's emails hear that the class is back on.
        const recipients = new Set(logRows
            .filter((row) => (currentEmailsByStudent.get(row.student_id) || []).includes(row.recipient))
            .map((row) => row.recipient));

        for (const recipient of recipients) {
            await sendEmail({
                to: recipient,
                subject: `Class back on: ${label}`,
                text: `Good news: the ${describeClass(groupClass)} on ${label} is going ahead after all.${getParentEmailFooter()}`
            }).catch((error) => console.error("Class restored email failed:", error.message));
        }
    }

    function dateInputWeekday(value) {
        return new Date(`${value}T00:00:00Z`).getUTCDay();
    }

    // Upcoming-class reminders go out from the evening before the class (reminders.dayBeforeFromHour)
    // until midday on the day (reminders.sameDayUntilHour), local business time, so a late restart still sends them.
    function getUpcomingReminderDate(groupClass, now = getLocalNow()) {
        const tomorrow = addDaysToDateInput(now.date, 1);

        if (dateInputWeekday(tomorrow) === groupClass.weekday && now.hour >= business.reminders.dayBeforeFromHour) {
            return tomorrow;
        }

        if (dateInputWeekday(now.date) === groupClass.weekday && now.hour < business.reminders.sameDayUntilHour) {
            return now.date;
        }

        return "";
    }

    let parentRemindersRunning = false;

    async function runParentReminders() {
        if (!parentEmailsEnabled || !isGmailConfigured || !isSupabaseConfigured || parentRemindersRunning) {
            return;
        }

        parentRemindersRunning = true;

        try {
            for (const groupClass of groupClasses) {
                const classDate = getUpcomingReminderDate(groupClass);

                if (!classDate || await getClassCancellation(groupClass, classDate)) {
                    continue;
                }

                const label = formatClassDateLabel(classDate);

                await sendToParentsBatch((await listGroupClassStudents(groupClass)).map((student) => ({
                    student,
                    key: `upcoming:${groupClass.id}:${classDate}:${student.id}`,
                    kind: "upcoming_class",
                    subject: `Reminder: ${groupClass.name} on ${label}`,
                    text: `A reminder that ${student.name}'s ${groupClass.name} is on ${label}${groupClass.time ? `, ${groupClass.time}` : ""}.\n\n`
                        + `Lesson credits left: ${student.credits}`
                })));
            }

            const lowStudents = (await listStudents()).filter((student) => student.status !== StudentStatus.inactive && student.credits <= lowCreditThreshold);
            const payments = lowStudents.length > 0 ? await listPaymentsForStudents(lowStudents.map((student) => student.id)) : [];

            await sendToParentsBatch(lowStudents.map((student) => getLowCreditReminder(student, payments.filter((payment) => payment.studentId === student.id))).filter(Boolean));
        } catch (error) {
            console.error("Parent reminders failed:", error.message);
        } finally {
            parentRemindersRunning = false;
        }
    }

    return {
        parentEmailBatchSize,
        getParentEmailsByStudent,
        listSentDedupeKeys,
        getParentEmailFooter,
        sendParentEmail,
        sendToParentsBatch,
        sendToParents,
        queueParentEmails,
        classDateJobs,
        classDateJobKey,
        runForClassDate,
        getLowCreditReminder,
        sendPaymentReceipt,
        attendanceEmailWording,
        sendAttendanceEmails,
        getClassCancellation,
        cancellationDedupeKey,
        cancelClass,
        restoreClass,
        sendCancellationEmails,
        sendClassRestoredEmails,
        getUpcomingReminderDate,
        runParentReminders
    };
}
