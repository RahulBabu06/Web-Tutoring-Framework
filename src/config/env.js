import fs from "fs";
import { dirname, isAbsolute, join } from "path";
import { fileURLToPath } from "url";

export const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function loadLocalEnv(filename) {
    const filePath = join(rootDir, filename);

    if (!fs.existsSync(filePath)) {
        return;
    }

    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);

    lines.forEach((line) => {
        const trimmedLine = line.trim();

        if (!trimmedLine || trimmedLine.startsWith("#") || !trimmedLine.includes("=")) {
            return;
        }

        const [key, ...valueParts] = trimmedLine.split("=");
        const value = valueParts.join("=").trim().replace(/^["']|["']$/g, "");

        if (!process.env[key]) {
            process.env[key] = value;
        }
    });
}

loadLocalEnv(".env");
loadLocalEnv(".env.local");

const weekdays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function readJsonFile(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error) {
        throw new Error(`Could not read business config ${filePath}: ${error.message}`);
    }
}

function envInteger(name, fallback) {
    const value = process.env[name];

    if (value === undefined || value === "") {
        return fallback;
    }

    const number = Number(value);
    return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

function slugify(value) {
    return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "site";
}

// Business settings live in business.config.json (or the file named by BUSINESS_CONFIG).
// A few values can be overridden from the environment so a deploy can change them without editing the file.
function loadBusinessConfig() {
    const configuredPath = process.env.BUSINESS_CONFIG || "business.config.json";
    const filePath = isAbsolute(configuredPath) ? configuredPath : join(rootDir, configuredPath);
    const file = fs.existsSync(filePath) ? readJsonFile(filePath) : {};

    if (!fs.existsSync(filePath)) {
        console.warn(`Business config ${filePath} not found; using built-in defaults.`);
    }

    const name = process.env.BUSINESS_NAME || file.name || "Your Tutoring Co";
    const contact = { email: "", phone: "", address: "", socialLinks: [], ...(file.contact || {}) };
    const attendance = {
        initialFreeSkips: 2,
        freeSkipsPerPaidBlock: 2,
        paidCreditsPerBlock: 10,
        maxFreeSkipsHeld: 2,
        lowCreditThreshold: 2,
        ...(file.attendance || {})
    };
    const reminders = { dayBeforeFromHour: 18, sameDayUntilHour: 12, ...(file.reminders || {}) };
    const lessonPack = { credits: 10, priceMinorUnits: 18000, ...(file.lessonPack || {}) };
    lessonPack.priceMinorUnits = envInteger("LESSON_PACK_PRICE_PENCE", lessonPack.priceMinorUnits);

    const seenClassIds = new Set();
    const groupClasses = (Array.isArray(file.groupClasses) ? file.groupClasses : []).map((groupClass, index) => {
        const day = String(groupClass.day || "").toLowerCase();
        const weekday = weekdays.indexOf(day);
        const id = slugify(groupClass.id || groupClass.name || `class-${index + 1}`);

        if (weekday === -1) {
            throw new Error(`groupClasses[${index}].day must be a weekday name (got "${groupClass.day}").`);
        }

        if (seenClassIds.has(id)) {
            throw new Error(`groupClasses[${index}].id "${id}" is used more than once.`);
        }

        seenClassIds.add(id);
        const className = String(groupClass.name || `${day[0].toUpperCase()}${day.slice(1)} group class`);
        const time = String(groupClass.time || "");

        return {
            id,
            name: className,
            day,
            dayLabel: `${day[0].toUpperCase()}${day.slice(1)}`,
            weekday,
            time,
            description: String(groupClass.description || ""),
            // Stored on each student as preferred_class, so changing name/time later means updating student records too.
            option: time ? `${className}, ${time}` : className
        };
    });

    const oneToOneFile = file.oneToOne || {};
    const oneToOne = {
        enabled: oneToOneFile.enabled !== false,
        label: String(oneToOneFile.label || "1-to-1 lessons"),
        description: String(oneToOneFile.description || ""),
        timeSlots: Array.isArray(oneToOneFile.timeSlots) ? oneToOneFile.timeSlots.map(String) : [],
        lessons: (Array.isArray(oneToOneFile.lessons) ? oneToOneFile.lessons : []).map((lesson) => {
            const minutes = Math.trunc(Number(lesson.minutes));
            return {
                minutes,
                label: String(lesson.label || `1-1 lesson (${minutes} minutes)`),
                pricePence: envInteger(`ONE_TO_ONE_${minutes}_PRICE_PENCE`, Math.trunc(Number(lesson.priceMinorUnits ?? lesson.pricePence ?? 0)))
            };
        }).filter((lesson) => lesson.minutes > 0)
    };

    return {
        name,
        shortName: file.shortName || name,
        slug: slugify(file.shortName || name),
        tagline: file.tagline || "",
        description: file.description || "",
        subject: file.subject || "tutoring",
        tutorName: file.tutorName || "",
        siteUrl: (process.env.SITE_URL || file.siteUrl || "http://localhost:4000").replace(/\/+$/, ""),
        contact,
        locale: process.env.LOCALE || file.locale || "en-GB",
        currency: (process.env.CURRENCY || file.currency || "GBP").toUpperCase(),
        timeZone: process.env.TIME_ZONE || file.timeZone || "Europe/London",
        replyWithinHours: Number(file.replyWithinHours) || 48,
        levels: Array.isArray(file.levels) && file.levels.length > 0 ? file.levels.map(String) : ["Beginner", "Intermediate", "Advanced"],
        groupClasses,
        oneToOne,
        lessonPack,
        attendance,
        reminders
    };
}

export const business = loadBusinessConfig();

export const bookingEmailAddress = process.env.GMAIL_USER || business.contact.email;
export const adminNotificationEmail = process.env.ADMIN_NOTIFICATION_EMAIL || bookingEmailAddress;
export const gmailOAuth = {
    clientId: process.env.GMAIL_OAUTH_CLIENT_ID || "",
    clientSecret: process.env.GMAIL_OAUTH_CLIENT_SECRET || "",
    refreshToken: process.env.GMAIL_OAUTH_REFRESH_TOKEN || ""
};

export const port = process.env.PORT || 4000;
const configuredDataDir = process.env.DATA_DIR || "data";
export const dataDir = isAbsolute(configuredDataDir) ? configuredDataDir : join(rootDir, configuredDataDir);
export const backupsDir = join(dataDir, "backups");
export const backupPageSize = 1000;

export const adminPassword = process.env.ADMIN_PASSWORD || "";
export const adminSessionSecret = process.env.ADMIN_SESSION_SECRET || "";
export const minAdminSessionSecretLength = 32;
export const isAdminSessionSecretValid = adminSessionSecret.length >= minAdminSessionSecretLength
    && adminSessionSecret !== adminPassword;
export const isAdminLoginConfigured = Boolean(adminPassword) && isAdminSessionSecretValid;

if (adminPassword && !isAdminSessionSecretValid) {
    console.warn(`Admin login is disabled: set ADMIN_SESSION_SECRET to a random value of at least ${minAdminSessionSecretLength} characters that differs from ADMIN_PASSWORD.`);
}
export const adminCookieName = "tutoring_admin";
export const adminSessionMs = 8 * 60 * 60 * 1000;

export const supabaseUrl = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
export const supabaseAdminKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
export const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || "";
export const supabaseRequestTimeoutMs = 10 * 1000;

export const parentAccessCookieName = "tutoring_parent_access";
export const parentRefreshCookieName = "tutoring_parent_refresh";
export const parentRefreshCookieMs = 30 * 24 * 60 * 60 * 1000;

export const inputLimits = {
    studentSearch: 100,
    refundReason: 1000,
    refundAdminNotes: 1000,
    cancelReason: 300,
    childName: 100,
    childRelationship: 50,
    childLinkNotes: 1000
};
