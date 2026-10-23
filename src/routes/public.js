import express from "express";
import { classOptions, groupClasses } from "../config/classes.js";
import { adminCookieName, business, parentAccessCookieName, parentRefreshCookieName } from "../config/env.js";

// Marketing pages are EJS templates in views/site/, filled in from business.config.json.
const pages = {
    "/": { view: "home", title: "" },
    "/lessons": { view: "lessons", title: "Lessons" },
    "/book-now": { view: "book-now", title: "Book a class" },
    "/thank-you": { view: "thank-you", title: "Thank you" },
    "/contact": { view: "contact", title: "Contact" },
    "/cookies": { view: "cookies", title: "Cookie policy" }
};

export function createPublicRouter({ formatMoney, isLessonPackForSale, lessonPackCredits, lessonPackPricePence }) {
    const router = express.Router();
    const siteLocals = {
        classOptions,
        groupClasses,
        lessonPack: isLessonPackForSale ? { credits: lessonPackCredits, priceLabel: formatMoney(lessonPackPricePence) } : null,
        oneToOne: {
            ...business.oneToOne,
            lessons: business.oneToOne.lessons.map((lesson) => ({ ...lesson, priceLabel: formatMoney(lesson.pricePence) }))
        },
        cookieNames: { admin: adminCookieName, parentAccess: parentAccessCookieName, parentRefresh: parentRefreshCookieName }
    };

    Object.entries(pages).forEach(([path, page]) => {
        router.get(path, (req, res) => {
            res.render(`site/${page.view}`, {
                ...siteLocals,
                currentPath: path,
                pageTitle: page.title,
                pageDescription: ""
            });
        });
    });

    return router;
}
