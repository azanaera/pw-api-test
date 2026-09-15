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
// local business-day boundary rather than echoing it verbatim. Comparing
// only the yyyy-MM-dd portion, this test is EXPECTED TO FAIL until that
// normalization is confirmed with the API team — treat a failure here as
// "day shifted by rating engine", not "test is broken".
const toDateOnly = (isoString) => isoString.slice(0, 10);

pm.test("response effective date matches request job date (date-only)", () => {
    pm.expect(toDateOnly(response.policyInfo.effectiveDt)).to.eql(
        toDateOnly(pm.collectionVariables.get("req_jobEffectiveDate"))
    );
});

pm.test("response expiration date matches request job date (date-only)", () => {
    pm.expect(toDateOnly(response.policyInfo.expirationDt)).to.eql(
        toDateOnly(pm.collectionVariables.get("req_jobExpirationDate"))
    );
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
