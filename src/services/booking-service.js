import { appendFile, mkdir, readFile } from "fs/promises";
import { join } from "path";
import { classOptions, getGroupClassForOption, oneToOneOption, oneToOneTimeSlots } from "../config/classes.js";
import { business, dataDir } from "../config/env.js";

const requiredFields = ["email", "childName", "level", "goals", "preferredClass"];
const bookingRequestsFile = join(dataDir, "booking-requests.jsonl");
const bookingRequestsShown = 200;

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

    function toBookingRecord(body, { lessonLength, timeSlot }) {
        return {
            receivedAt: new Date().toISOString(),
            email: body.email.trim(),
            studentName: body.childName.trim(),
            level: body.level,
            goals: body.goals.trim(),
            preferredClass: body.preferredClass,
            timeSlot,
            lessonLength: lessonLength ? `${lessonLength.label}, ${formatMoney(lessonLength.pricePence)}` : ""
        };
    }

    // Every request is kept on the server too, so none are lost if email isn't set up or fails.
    async function saveBookingRequest(body, booking) {
        await mkdir(dataDir, { recursive: true });
        await appendFile(bookingRequestsFile, JSON.stringify(toBookingRecord(body, booking)) + "\n", "utf8");
    }

    async function listBookingRequests() {
        let contents;
        try {
            contents = await readFile(bookingRequestsFile, "utf8");
        } catch (error) {
            if (error.code === "ENOENT") {
                return [];
            }
            throw error;
        }

        return contents.split("\n")
            .filter((line) => line.trim() !== "")
            .flatMap((line) => {
                try {
                    return [JSON.parse(line)];
                } catch {
                    return [];
                }
            })
            .reverse()
            .slice(0, bookingRequestsShown);
    }

    function sendBookingEmail(body, { lessonLength, timeSlot }) {
        return email.sendEmail({
            to: bookingEmailAddress,
            subject: "Student name: " + body.childName.replace(/[\r\n]+/g, " "),
            text: "Email address: " + body.email + "\nGoals: " + body.goals + "\nLevel: " + body.level + "\nPreferred class: " + body.preferredClass + "\nPreferred timeslot: " + timeSlot
                + (lessonLength ? `\nLesson length: ${lessonLength.label}, ${formatMoney(lessonLength.pricePence)}` : "")
        });
    }

    return { isEmailConfigured: email.isConfigured, bookingRequestsFile, validateBooking, saveBookingRequest, listBookingRequests, sendBookingEmail };
}
