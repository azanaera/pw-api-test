// ============================================================
// TESTS SCRIPT (Postman "Tests" tab)
// Requires: quote_response.schema.json injected as the
// "quoteResponseSchema" environment variable (see note at bottom
// on wiring this into Newman/GitLab CI).
// ============================================================

const response = pm.response.json();

// ------------------------------------------------------------
// 1. Basic sanity checks
// ------------------------------------------------------------
pm.test("Status code is 200", () => {
    pm.response.to.have.status(200);
});

pm.test("Response has msgStatus = quoted", () => {
    pm.expect(response.msgStatus).to.eql("quoted");
});

pm.test("errorresponse is empty", () => {
    pm.expect(response.errorresponse).to.be.an("object").that.is.empty;
});

// ------------------------------------------------------------
// 2. Schema validation
// ------------------------------------------------------------
const rawSchema = pm.environment.get("quoteResponseSchema");

if (!rawSchema) {
    console.warn(
        "quoteResponseSchema env var not set — skipping schema validation. " +
        "See bottom of this file for how to inject it in CI."
    );
} else {
    const schema = JSON.parse(rawSchema);

    pm.test("Response matches quote response schema", () => {
        const valid = tv4.validate(response, schema);
        if (!valid) {
            console.log("Schema validation error:", tv4.error);
        }
        pm.expect(valid, tv4.error ? tv4.error.message : "").to.be.true;
    });
}

// ------------------------------------------------------------
// 3. Structural checks the schema alone won't catch
//    (cardinality / non-empty checks, not just "is it an array")
// ------------------------------------------------------------
pm.test("payment is a non-empty array of plan objects", () => {
    pm.expect(response.payment).to.be.an("array").that.is.not.empty;
    response.payment.forEach((plan) => {
        pm.expect(plan).to.have.property("paymentPlanCd").that.is.a("string");
        pm.expect(plan).to.have.property("planPremium").that.is.a("string");
        pm.expect(plan).to.have.property("additionalQuotedScenario").that.is.an("array");
    });
});

pm.test("options is a non-empty array with numeric premium fields", () => {
    pm.expect(response.options).to.be.an("array").that.is.not.empty;
    response.options.forEach((opt) => {
        pm.expect(opt.totalPremium).to.be.a("number");
        pm.expect(opt.installment).to.be.a("number");
        pm.expect(opt.fee).to.be.a("number");
        pm.expect(opt.downPayment).to.be.a("number");
        pm.expect(opt.installmentData).to.be.an("array").that.is.not.empty;
    });
});

pm.test("every option's installmentData sums to a sane total", () => {
    // Compute sum vs. totalPremium for EVERY plan first, then fail once with
    // every offending plan listed — a forEach-based assertion stops at the
    // first mismatch and hides whether other plans are also affected.
    const TOLERANCE = 1.0; // a few cents of rounding slack across installments
    const mismatches = response.options
        .map((opt) => {
            const sum = opt.installmentData.reduce(
                (acc, i) => acc + parseFloat(i.amount),
                0
            );
            return { opt, sum, diff: sum - opt.totalPremium };
        })
        .filter(({ diff }) => Math.abs(diff) > TOLERANCE);

    const message = mismatches
        .map(({ opt, sum, diff }) =>
            `${opt.paymentPlanName} (${opt.paymentType}): installments sum to ${sum.toFixed(2)}, ` +
            `expected ~${opt.totalPremium.toFixed(2)} (diff ${diff >= 0 ? "+" : ""}${diff.toFixed(2)})`
        )
        .join(" | ");

    pm.expect(mismatches.length, message).to.eql(0);
});

pm.test("quoteInfo has a usable quoteID and URLs", () => {
    pm.expect(response.quoteInfo.quoteID).to.match(
        /^[0-9a-f-]{36}$/i,
        "quoteID should be a UUID"
    );
    pm.expect(response.quoteInfo.summaryURL).to.include(response.quoteInfo.quoteID);
    pm.expect(response.quoteInfo.bridgeURL).to.include(response.quoteInfo.quoteID);
});

// ------------------------------------------------------------
// 4. Request <-> response cross-field assertions
//    (relies on collection variables set in the Pre-request script)
// ------------------------------------------------------------
pm.test("response VIN matches request VIN", () => {
    pm.expect(response.vehicles[0].vin).to.eql(
        pm.collectionVariables.get("req_vin")
    );
});

pm.test("response driver license matches request", () => {
    const driver = response.drivers[0];
    pm.expect(driver.licenseNumber).to.eql(pm.collectionVariables.get("req_licenseNumber"));
    pm.expect(driver.licenseState).to.eql(pm.collectionVariables.get("req_licenseState"));
});

pm.test("response insured name matches request", () => {
    const insured = response.policyInfo.insured;
    pm.expect(insured.firstName).to.eql(pm.collectionVariables.get("req_insuredFirstName"));
    pm.expect(insured.lastName).to.eql(pm.collectionVariables.get("req_insuredLastName"));
    pm.expect(insured.emailAddress1).to.eql(pm.collectionVariables.get("req_insuredEmail"));
});

// NOTE: effectiveDt/expirationDt come back with a different clock time
// AND, in this sample, a different calendar day than what was requested
// (request 2026-07-26T00:00:00Z -> response 2026-07-25T05:01:00Z). That's
// consistent with the rating engine snapping the effective date to a
// local business-day boundary rather than echoing it verbatim. Rather than
// asserting exact equality (which always fails on this known shift) or
// hard-coding "-1 day" as a KNOWN ISSUE (which would silently pass if the
// engine started shifting by 2+ days, or the other direction), this
// computes the actual day delta and bounds it to the known range — so a
// real regression (bigger drift, wrong direction) still fails loudly, and
// the message always reports the actual delta for triage.
const toDateOnly = (isoString) => isoString.slice(0, 10);
const dayDelta = (respIso, reqIso) => {
    const resp = new Date(`${toDateOnly(respIso)}T00:00:00Z`);
    const req = new Date(`${toDateOnly(reqIso)}T00:00:00Z`);
    return Math.round((resp - req) / 86400000);
};

pm.test("response effective date matches request job date (date-only, within known rating-engine shift)", () => {
    const respIso = response.policyInfo.effectiveDt;
    const reqIso = pm.collectionVariables.get("req_jobEffectiveDate");
    const delta = dayDelta(respIso, reqIso);
    pm.expect(delta, `response effectiveDt ${toDateOnly(respIso)} is ${delta} day(s) from requested ` +
        `${toDateOnly(reqIso)} (expected 0, or -1 for the known rating-engine business-day shift)`).to.be.within(-1, 0);
});

pm.test("response expiration date matches request job date (date-only, within known rating-engine shift)", () => {
    const respIso = response.policyInfo.expirationDt;
    const reqIso = pm.collectionVariables.get("req_jobExpirationDate");
    const delta = dayDelta(respIso, reqIso);
    pm.expect(delta, `response expirationDt ${toDateOnly(respIso)} is ${delta} day(s) from requested ` +
        `${toDateOnly(reqIso)} (expected 0, or -1 for the known rating-engine business-day shift)`).to.be.within(-1, 0);
});

pm.test("response producerCode matches request", () => {
    pm.expect(response.policyInfo.producerCode.id).to.eql(
        pm.collectionVariables.get("req_producerCode")
    );
});

// Vehicle make/model are NOT expected to match verbatim (rating engine
// normalizes them — e.g. "TOYOTA"/"CAMRY XSE" in, "TYTA"/"CAMRY HYBRID XSE"
// out). Flag it as informational rather than failing the run.
pm.test("INFO: vehicle make/model normalization (non-failing)", () => {
    const reqMake = pm.collectionVariables.get("req_make");
    const reqModel = pm.collectionVariables.get("req_model");
    const respMake = response.vehicles[0].make;
    const respModel = response.vehicles[0].model;
    if (reqMake !== respMake || reqModel !== respModel) {
        console.log(
            `Vehicle normalized by rating engine: request "${reqMake} ${reqModel}" -> response "${respMake} ${respModel}"`
        );
    }
    pm.expect(true).to.be.true; // always passes; this test exists to surface the log line
});

// ------------------------------------------------------------
// 5. Known data-quality gaps — assert the CURRENT (buggy) behavior
//    so a silent backend fix or regression both get caught, and
//    leave a breadcrumb pointing back to the discussion with the
//    API team.
// ------------------------------------------------------------
pm.test("KNOWN ISSUE: validUntil is the string \"null\", not JSON null", () => {
    // TODO: remove/flip this assertion once backend fixes the type.
    pm.expect(response.policyInfo.insured.primaryAddress.validUntil).to.eql("null");
});

pm.test("KNOWN ISSUE: payment[].planPremium is a string with embedded currency", () => {
    // e.g. "844.00 usd" instead of a numeric amount + separate currency field.
    // TODO: flip to a numeric-type assertion once backend normalizes this.
    response.payment.forEach((plan) => {
        pm.expect(plan.planPremium).to.match(/^\d+\.\d{2}\s+usd$/i);
    });
});

pm.test("KNOWN ISSUE: EFT/RCC installments are Direct Bill's schedule minus the flat fee difference, not repriced off their own totalPremium", () => {
    // Root cause behind "every option's installmentData sums to a sane total"
    // failing for every EFT/RCC plan (see that test above): for a given plan
    // name, EFT/RCC's installment amounts equal the Direct Bill plan's
    // installment amounts minus (directFee - eftOrRccFee), installment for
    // installment — instead of being amortized from EFT/RCC's own
    // totalPremium. That's why the sums drift from totalPremium by amounts
    // that track the Direct/EFT premium gap, not by fee alone.
    // Confirmed identically across two independent sample quotes, with one
    // consistent quirk both times: the "1-Month Down" plan's FIRST
    // installment is billed before the fee applies, so it matches Direct's
    // first installment exactly (no fee subtracted) — every other
    // installment, on every plan, does get the flat fee difference
    // subtracted, including "1-Month Down"'s remaining installments.
    // TODO: once the backend reprices EFT/RCC installments off their own
    // premium, this assertion will start failing — flip it to assert the
    // installments reconcile to totalPremium instead (i.e. delete this test,
    // the aggregate sum-check above already covers the correct behavior).
    const TOLERANCE = 0.02;
    const directPlans = response.options.filter((o) => o.paymentType === "Direct");
    const otherPlans = response.options.filter((o) => o.paymentType === "EFT" || o.paymentType === "RCC");

    const mismatches = [];
    otherPlans.forEach((opt) => {
        const directPlan = directPlans.find((d) => d.paymentPlanName === opt.paymentPlanName);
        if (!directPlan) return; // e.g. "Paid in Full" has no Direct Bill counterpart to compare against

        if (directPlan.installmentData.length !== opt.installmentData.length) {
            mismatches.push(
                `${opt.paymentPlanName} (${opt.paymentType}): installment count ${opt.installmentData.length} ` +
                `!= Direct's ${directPlan.installmentData.length}`
            );
            return;
        }

        const feeDiff = directPlan.fee - opt.fee;
        opt.installmentData.forEach((inst, i) => {
            const actual = parseFloat(inst.amount);
            const directAmt = parseFloat(directPlan.installmentData[i].amount);
            const isFeeExemptFirstInstallment = i === 0 && opt.paymentPlanName === "1-Month Down";
            const expected = isFeeExemptFirstInstallment ? directAmt : directAmt - feeDiff;
            if (Math.abs(actual - expected) > TOLERANCE) {
                mismatches.push(
                    `${opt.paymentPlanName} (${opt.paymentType}) installment #${i + 1}: ${actual.toFixed(2)}, ` +
                    `expected ${expected.toFixed(2)} (Direct ${directAmt.toFixed(2)}` +
                    `${isFeeExemptFirstInstallment ? ", fee-exempt first installment" : ` - feeDiff ${feeDiff.toFixed(2)}`})`
                );
            }
        });
    });

    // Asserting the BUG pattern currently holds for every installment checked
    // (empty mismatches list = the known pattern was found everywhere it
    // should be) — so this test fails the moment the pattern breaks, in
    // either direction.
    pm.expect(mismatches.length, mismatches.join(" | ")).to.eql(0);
});

// ============================================================
// CI WIRING NOTE (GitLab CI / Newman):
// Inject the schema as an environment variable before the run, e.g.:
//
//   newman run collections/quote.postman_collection.json \
//     -e environments/uat.postman_environment.json \
//     --env-var "quoteResponseSchema=$(cat schemas/quote_response.schema.json | jq -c .)" \
//     --reporters cli,junit \
//     --reporter-junit-export newman-results.xml
//
// jq -c collapses it to one line so it survives as a single env-var value.
// ============================================================
