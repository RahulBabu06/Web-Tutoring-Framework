import express from "express";
import { StudentStatus, groupClasses } from "../config/classes.js";
import { adminCookieName, adminSessionMs, isAdminLoginConfigured } from "../config/env.js";
import { loginRateLimiter } from "../middleware/rate-limiters.js";

export function createAdminRouter({
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
}) {
    const router = express.Router();

    router.get("/admin", requireAdmin, asyncHandler(async (req, res) => {
        let students = [];
        let classSummaries = [];
        const setupError = await loadAdminData(async () => {
            students = await listStudents();
            classSummaries = await Promise.all(groupClasses.map(async (groupClass) => {
                const nextDate = getNextClassDate(groupClass);
                const lastDate = getDefaultClassDate(groupClass);
                const roster = students.filter((student) => student.status !== StudentStatus.inactive && student.preferredClass === groupClass.option);
                const [nextClass, lastClass] = await Promise.all([
                    loadClassDateStatus(groupClass, nextDate, roster),
                    lastDate === nextDate
                        ? null
                        : loadClassDateStatus(groupClass, lastDate, roster.filter((student) => !student.createdAt || student.createdAt.slice(0, 10) <= lastDate))
                ]);

                return {
                    groupClass,
                    rosterCount: roster.length,
                    nextClass,
                    lastClassNeedsRegister: lastClass && lastClass.unmarkedCount > 0 && !lastClass.cancellation ? lastClass : null
                };
            }));
        });

        const activeStudents = students.filter((student) => student.status !== StudentStatus.inactive);
        const counts = res.locals.adminPendingCounts || { parentLinks: 0, refunds: 0 };
        const classesNeedingRegister = classSummaries.filter((summary) => summary.lastClassNeedsRegister);
        const lowCreditStudents = activeStudents
            .filter((student) => student.credits <= lowCreditThreshold)
            .sort((a, b) => a.credits - b.credits || a.name.localeCompare(b.name));
        const noClassStudents = activeStudents.filter((student) => !student.preferredClass);
        const noEmailStudents = activeStudents.filter((student) => !student.parentEmail);
        const todoCount = [
            ...classesNeedingRegister,
            counts.parentLinks > 0,
            counts.refunds > 0,
            lowCreditStudents.length > 0,
            noClassStudents.length > 0,
            noEmailStudents.length > 0
        ].filter(Boolean).length;

        res.render("admin-home", {
            isSupabaseConfigured,
            setupError,
            classSummaries,
            classesNeedingRegister,
            activeCount: activeStudents.length,
            inactiveCount: students.length - activeStudents.length,
            pendingParentLinks: counts.parentLinks,
            pendingRefunds: counts.refunds,
            lowCreditStudents,
            noClassStudents,
            noEmailStudents,
            todoCount,
            lowCreditThreshold
        });
    }));

    router.get("/admin/login", (req, res) => {
        res.setHeader("Cache-Control", "no-store");
        res.render("admin-login", {
            error: req.query.error === "1",
            isConfigured: isAdminLoginConfigured
        });
    });

    router.post("/admin/login", loginRateLimiter, (req, res) => {
        if (!isAdminPasswordCorrect(req.body.password)) {
            return res.redirect("/admin/login?error=1");
        }

        res.cookie(adminCookieName, createAdminToken(), adminCookieOptions(req, adminSessionMs));
        res.redirect("/admin");
    });

    router.post("/admin/logout", (req, res) => {
        revokeAdminToken(parseCookies(req)[adminCookieName]);
        res.clearCookie(adminCookieName, adminCookieOptions(req, 0));
        res.redirect("/admin/login");
    });

    return router;
}
