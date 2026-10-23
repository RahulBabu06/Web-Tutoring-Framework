import express from "express";
import { business } from "../config/env.js";
import { bookingStatuses } from "../services/booking-service.js";
import { bookingRateLimiter } from "../middleware/rate-limiters.js";

export function createBookingRouter({ bookingService, requireAdmin }) {
    const router = express.Router();

    router.post("/book-now", bookingRateLimiter, async (req, res) => {
        const booking = bookingService.validateBooking(req.body);

        if (!booking) {
            return res.redirect(303, "/book-now?error=details#page-title");
        }

        let isSaved = false;
        try {
            await bookingService.saveBookingRequest(req.body, booking);
            isSaved = true;
        } catch (error) {
            console.error("Booking request could not be saved:", error.message);
        }

        if (!bookingService.isEmailConfigured) {
            if (!isSaved) {
                return res.status(503).send(`Sorry, your request couldn't be sent. Please email ${business.contact.email} instead.`);
            }
            console.warn("Booking request saved to " + bookingService.bookingRequestsFile + " (Gmail API isn't set up, so no email was sent). See /admin/booking-requests.");
            return res.redirect("/thank-you");
        }

        bookingService.sendBookingEmail(req.body, booking)
            .then(() => console.log("Email sent successfully"))
            .catch((error) => console.error("Booking email failed:", error.message));

        res.redirect("/thank-you");
    });

    const bookingRequestsPerPage = 50;
    const statusFilters = ["open", ...bookingStatuses, "all"];

    function bookingListQuery({ q, status, page }) {
        const params = new URLSearchParams();
        if (q) params.set("q", q);
        if (status !== "open") params.set("status", status);
        if (page > 1) params.set("page", String(page));
        const query = params.toString();
        return query ? `?${query}` : "";
    }

    function readBookingFilters(source) {
        const q = typeof source.q === "string" ? source.q.trim().slice(0, 100) : "";
        const status = statusFilters.includes(source.status) ? source.status : "open";
        const page = Math.max(1, Number.parseInt(source.page, 10) || 1);
        return { q, status, page };
    }

    router.get("/admin/booking-requests", requireAdmin, async (req, res, next) => {
        try {
            const filters = readBookingFilters(req.query);
            const dateFormat = new Intl.DateTimeFormat(business.locale, { dateStyle: "medium", timeStyle: "short", timeZone: business.timeZone });
            const allRequests = await bookingService.listBookingRequests();
            const counts = Object.fromEntries(bookingStatuses.map((status) => [status, allRequests.filter((request) => request.status === status).length]));
            const search = filters.q.toLowerCase();
            const matching = allRequests.filter((request) => {
                const statusMatches = filters.status === "all"
                    || (filters.status === "open" ? ["new", "contacted"].includes(request.status) : request.status === filters.status);
                const searchMatches = !search || [request.studentName, request.email, request.goals, request.preferredClass, request.level]
                    .some((value) => String(value || "").toLowerCase().includes(search));
                return statusMatches && searchMatches;
            });
            const pageCount = Math.max(1, Math.ceil(matching.length / bookingRequestsPerPage));
            const page = Math.min(filters.page, pageCount);
            const requests = matching.slice((page - 1) * bookingRequestsPerPage, page * bookingRequestsPerPage).map((request) => ({
                ...request,
                receivedLabel: request.receivedAt ? dateFormat.format(new Date(request.receivedAt)) : "",
                newStudentHref: "/admin/students/new?" + new URLSearchParams({ name: request.studentName || "", parentEmail: request.email || "" })
            }));
            res.render("admin-booking-requests", {
                requests,
                counts,
                bookingStatuses,
                statusFilters,
                filters: { ...filters, page },
                matchingCount: matching.length,
                pageCount,
                previousHref: page > 1 ? "/admin/booking-requests" + bookingListQuery({ ...filters, page: page - 1 }) : "",
                nextHref: page < pageCount ? "/admin/booking-requests" + bookingListQuery({ ...filters, page: page + 1 }) : "",
                updated: req.query.updated === "1",
                isEmailConfigured: bookingService.isEmailConfigured
            });
        } catch (error) {
            next(error);
        }
    });

    router.post("/admin/booking-requests/:id/status", requireAdmin, async (req, res, next) => {
        try {
            const filters = readBookingFilters(req.body);
            const updated = /^[A-Za-z0-9-]{8,64}$/.test(req.params.id)
                && await bookingService.setBookingRequestStatus(req.params.id, req.body.newStatus);
            if (!updated) {
                return res.status(400).render("error", { pageTitle: "Could not update request", pageDescription: "", currentPath: req.path, status: 400, message: "That booking request or status wasn't found." });
            }
            const query = bookingListQuery(filters);
            res.redirect(303, "/admin/booking-requests" + (query ? `${query}&updated=1` : "?updated=1"));
        } catch (error) {
            next(error);
        }
    });

    return router;
}
