import express from "express";
import { business } from "../config/env.js";
import { bookingRateLimiter } from "../middleware/rate-limiters.js";

export function createBookingRouter({ bookingService, requireAdmin }) {
    const router = express.Router();

    router.post("/book-now", bookingRateLimiter, async (req, res) => {
        const booking = bookingService.validateBooking(req.body);

        if (!booking) {
            return res.status(400).send("Please complete all booking details before submitting.");
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

    router.get("/admin/booking-requests", requireAdmin, async (req, res, next) => {
        try {
            const dateFormat = new Intl.DateTimeFormat(business.locale, { dateStyle: "medium", timeStyle: "short", timeZone: business.timeZone });
            const requests = (await bookingService.listBookingRequests()).map((request) => ({
                ...request,
                receivedLabel: request.receivedAt ? dateFormat.format(new Date(request.receivedAt)) : ""
            }));
            res.render("admin-booking-requests", { requests, isEmailConfigured: bookingService.isEmailConfigured });
        } catch (error) {
            next(error);
        }
    });

    return router;
}
