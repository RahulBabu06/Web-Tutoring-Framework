import { business } from "./env.js";

// Group classes meet weekly on a configured day; each has its own register, keyed by groupClass.id.
export const groupClasses = business.groupClasses;
export const oneToOneOption = business.oneToOne.enabled ? business.oneToOne.label : "";
export const oneToOneTimeSlots = business.oneToOne.timeSlots;
// The values a student's preferred_class can take.
export const classOptions = [...groupClasses.map((groupClass) => groupClass.option), oneToOneOption].filter(Boolean);

export function getGroupClass(classId) {
    return groupClasses.find((groupClass) => groupClass.id === classId) || null;
}

export function getGroupClassForOption(option) {
    return groupClasses.find((groupClass) => groupClass.option === option) || null;
}

export const StudentStatus = Object.freeze({ active: "active", inactive: "inactive" });
export const LinkStatus = Object.freeze({ pending: "pending", approved: "approved", rejected: "rejected" });
export const RefundStatus = Object.freeze({ pending: "pending", approved: "approved", declined: "declined" });
export const PaymentStatus = Object.freeze({ pending: "pending", paid: "paid", failed: "failed", refunded: "refunded", cancelled: "cancelled" });
export const paymentStatuses = Object.values(PaymentStatus);
export const AttendanceStatus = Object.freeze({ present: "present", absent: "absent" });
