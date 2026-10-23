import assert from "node:assert/strict";
import test from "node:test";
import { business } from "../src/config/env.js";
import { classOptions, getGroupClass, getGroupClassForOption, groupClasses, oneToOneOption } from "../src/config/classes.js";

test("every group class has a weekday and a register id", () => {
    assert.ok(groupClasses.length > 0);

    groupClasses.forEach((groupClass) => {
        assert.ok(groupClass.weekday >= 0 && groupClass.weekday <= 6);
        assert.equal(getGroupClass(groupClass.id), groupClass);
        assert.equal(getGroupClassForOption(groupClass.option), groupClass);
    });
});

test("class options list every group class plus 1-to-1 lessons", () => {
    assert.deepEqual(classOptions, [...groupClasses.map((groupClass) => groupClass.option), oneToOneOption].filter(Boolean));
});

test("money settings are usable", () => {
    assert.doesNotThrow(() => new Intl.NumberFormat(business.locale, { style: "currency", currency: business.currency }));
    assert.ok(business.lessonPack.credits > 0);
    assert.ok(business.attendance.paidCreditsPerBlock > 0);
});
