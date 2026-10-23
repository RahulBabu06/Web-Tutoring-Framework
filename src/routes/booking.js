import express from "express";
import { bookingRateLimiter } from "../middleware/rate-limiters.js";

export function createBookingRouter({ bookingService }) {
    const router = express.Router();

    router.post("/book-now", bookingRateLimiter, (req, res) => {
        const booking = bookingService.validateBooking(req.body);

        if (!booking) {
            return res.status(400).send("Please complete all booking details before submitting.");
        }

        if (!bookingService.isEmailConfigured) {
            console.error("Booking received but the Gmail API is not configured; email not sent.");
            return res.redirect("/thank-you");
        }

        bookingService.sendBookingEmail(req.body, booking)
            .then(() => console.log("Email sent successfully"))
            .catch((error) => console.error("Booking email failed:", error.message));

        res.redirect("/thank-you");
    });

    return router;
}
