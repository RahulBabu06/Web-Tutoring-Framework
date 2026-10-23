import { classOptions, getGroupClassForOption, oneToOneOption, oneToOneTimeSlots } from "../config/classes.js";
import { business } from "../config/env.js";

const requiredFields = ["email", "childName", "level", "goals", "preferredClass"];

export function createBookingService({ email, bookingEmailAddress, getOneToOneLesson, formatMoney }) {
    function validateBooking(body) {
        const hasAllDetails = requiredFields.every((field) => {
            return typeof body[field] === "string" && body[field].trim() !== "";
        });
        const isOneToOne = Boolean(oneToOneOption) && body.preferredClass === oneToOneOption;
        const hasValidTimeSlot = !isOneToOne || oneToOneTimeSlots.includes(body.preferredTimeSlot);
        const lessonLength = isOneToOne ? getOneToOneLesson(body.lessonLength) : null;

        if (!hasAllDetails || !classOptions.includes(body.preferredClass) || !business.levels.includes(body.level) || !hasValidTimeSlot || (isOneToOne && !lessonLength)) {
            return null;
        }

        const groupClass = getGroupClassForOption(body.preferredClass);
        const timeSlot = isOneToOne ? body.preferredTimeSlot : `${groupClass.dayLabel}${groupClass.time ? ` ${groupClass.time}` : ""}`;
        return { lessonLength, timeSlot };
    }

    function sendBookingEmail(body, { lessonLength, timeSlot }) {
        return email.sendEmail({
            to: bookingEmailAddress,
            subject: "Student name: " + body.childName.replace(/[\r\n]+/g, " "),
            text: "Email address: " + body.email + "\nGoals: " + body.goals + "\nLevel: " + body.level + "\nPreferred class: " + body.preferredClass + "\nPreferred timeslot: " + timeSlot
                + (lessonLength ? `\nLesson length: ${lessonLength.label}, ${formatMoney(lessonLength.pricePence)}` : "")
        });
    }

    return { isEmailConfigured: email.isConfigured, validateBooking, sendBookingEmail };
}
