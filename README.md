# pw-api-test — Trexis Quote API Tests

Postman test script plus captured sample responses for the Trexis Personal Auto **quote** API (UAT). The script runs in the request's Postman **Tests** tab. In CI it runs through Newman.

> The folder is named "playwright apis", but `test.js` is a **Postman** script (`pm.test` / `pm.expect`), not a Playwright spec.

## Files

| File | What it is |
|---|---|
| `test.js` | The current Postman test script. Paste it into the request's **Tests** tab. |
| `origTest.txt` | The original script before any of the changes below, kept for reference. |
| `response.json` | Sample response 1: insured `autoa abcd`, 2006 Honda Civic, quote `0005a3f6…`, captured 2026-09-15. |
| `response_2.json` | Sample response 2: insured `John Smith`, 2021 Toyota Camry Hybrid, quote `2e12fa8b…`, captured 2026-09-16. |
| `response_3.json` | Sample response 3: same customer and vehicle as sample 1, re-quoted 2026-09-24 (quote `1d393f85…`). |

> **Postman does not sync with this repo.** After `test.js` changes, copy the whole file into Postman's Tests tab again. One failure during this work came from Postman still running an older copy of the script.

## Changes to `test.js`

Each change is its own commit, so `git log -p test.js` shows the diffs.

1. **The installment-sum test now reports every failing plan** (`04919af`)
   The original `forEach` assertion stopped at the first plan whose installments didn't add up to `totalPremium`. The test now checks every plan, then fails once and lists each bad plan with its difference. That's what showed the problem affects every EFT/RCC plan, not just one.

2. **Date checks allow the known one-day shift** (`792db9a`)
   The response comes back one day earlier than the request (`2026-07-26` requested, `2026-07-25T05:01:00Z` returned). The old exact-date check therefore always failed. The test now computes the day difference and accepts `0` or `-1`. A bigger drift, or a shift in the other direction, still fails, and the message shows the actual difference.

3. **New KNOWN ISSUE test for EFT/RCC installment pricing** (`4560787`)
   This test asserts the buggy pattern described under Findings. If the backend fixes the bug, or the bug changes shape, the test fails.

4. **Fix: "1-Month Down" first installment has no fee** (`678f5fb`)
   A per-installment comparison across the fixtures showed that the first installment of the "1-Month Down" plan equals Direct Bill's first installment exactly, with no fee subtracted. Change 3 hadn't accounted for this, so it was fixed. The test passes with 0 mismatches against all three fixtures.

Other tests were left as they were: status, `msgStatus`, empty `errorresponse`, optional schema validation (tv4), request/response cross-checks, and the vehicle normalization INFO log.

## Findings (backend issues to raise with the API team)

### 1. EFT/RCC installments don't add up to `totalPremium`

This happens in every EFT and RCC plan in all three samples. Direct Bill and Paid in Full plans add up exactly.

| Plan (EFT and RCC) | Sample 1 & 3: sum vs total | Sample 2: sum vs total |
|---|---|---|
| 1-Month Down | 1248.00 vs 1023.00 (**+225.00**) | 1173.00 vs 1061.00 (**+112.00**) |
| 10% Down | 1122.00 vs 1029.00 (**+93.00**) | 1176.00 vs 1067.00 (**+109.00**) |
| 11% Down | 1122.00 vs 1029.00 (**+93.00**) | 1176.00 vs 1067.00 (**+109.00**) |
| 12.50% Down | 976.00 vs 1029.00 (**−53.00**) | 1176.00 vs 1067.00 (**+109.00**) |
| 16.67% Down | 976.00 vs 1029.00 (**−53.00**) | 1176.00 vs 1067.00 (**+109.00**) |

**Likely root cause:** each EFT/RCC installment is the same-named Direct Bill plan's installment minus the flat fee difference (Direct `$10` − EFT/RCC `$6` = **`$4.00`**). The schedule isn't calculated from the EFT/RCC plan's own `totalPremium`. The one exception is the first installment of "1-Month Down", which equals Direct's first installment exactly.

```
Direct − EFT/RCC, per installment (same in all three samples):
1-Month Down:           [0, 4, 4, 4, 4, 4, 4, 4, 4, 4]
10/11/12.50/16.67% Down: [4, 4, 4, 4, 4, 4, 4, 4, 4, 4]
```

The installments only account for the $4 fee difference, not the actual premium gap between Direct Bill and EFT/RCC, so the sums drift from `totalPremium`.

### 2. Effective and expiration dates shift by one day

`effectiveDt` and `expirationDt` come back one calendar day earlier than requested, with the time set to `05:01:00Z`. This looks like the rating engine snapping dates to a local business-day boundary. The API team should confirm whether this is intended, since it changes when coverage starts and ends.

### 3. Data-type problems (tracked as KNOWN ISSUE tests)

- `primaryAddress.validUntil` is the **string** `"null"`, not JSON `null`.
- `payment[].planPremium` is a string with the currency inside it (`"949.00 usd"`), not a number plus a separate currency field.

### 4. Insured and driver names don't match (sample 2)

`policyInfo.insured.lastName` is `"Smith"`, but `drivers[0].contact.lastName` is `"S mith"` (with a space) for the same person. No test checks this yet. Compare it with what the request actually sent before reporting it.

### 5. Other differences between samples (not bugs)

- Sample 2's Paid in Full plan has `fee: 30.00` and `noOfInstallments: 1`. Samples 1 and 3 have `0` and `0`.
- Sample 2's driver has an extra `filingRequired` field, and its vehicle has an extra `bodyType` field. A strict schema would need to allow these.
- The first installment amount changes with the date the quote is run (sample 1: `110.37` on 09-15; sample 3: `102.85` on 09-24). That's because the number of days from statement date to due date changes.

## Postman AI's suggested rewrite (not used)

Postman AI suggested replacing the script. It was rejected because it would make things worse:

- `errorresponse` was checked with `to.be.undefined`, which **fails** on the real response (`{}`).
- The "options" test actually looped over `payment`, so `options` was never checked.
- It dropped the installment, date, driver, insured, producerCode and known-issue checks.
- It got the VIN by splitting the `coverable` label string instead of reading `vehicles[0].vin`.

## Next steps

- [ ] Report Findings 1 and 2 to the API/backend team with the per-installment table above.
- [ ] When the EFT/RCC pricing is fixed, delete the KNOWN ISSUE pricing test. The installment-sum test already checks the correct behavior.
- [ ] Check whether the `"S mith"` last name came from the request, and add an insured/driver name check if it's a backend problem.
- [ ] Update the two data-type KNOWN ISSUE tests once the backend fixes those fields.

## Running in CI (Newman)

```bash
newman run collections/quote.postman_collection.json \
  -e environments/uat.postman_environment.json \
  --env-var "quoteResponseSchema=$(cat schemas/quote_response.schema.json | jq -c .)" \
  --reporters cli,junit \
  --reporter-junit-export newman-results.xml
```

Schema validation runs only when the `quoteResponseSchema` environment variable is set. The collection, environment and schema files aren't in this repo yet.
