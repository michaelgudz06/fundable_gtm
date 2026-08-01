/**
 * Registry label -> HubSpot picklist INTERNAL NAME.
 *
 * VERIFIED against the live `ICP Segment` contact property on 2026-07-31, not
 * inferred. That distinction matters: this table was originally carried over
 * from a deleted Python port and nobody had compared it to the real property.
 *
 * A HubSpot write uses the internal name, never the label. The labels happen to
 * be our exact output ("ICP #2: CRE Broker"), which is convenient for a human
 * reading a contact record and irrelevant to the API call.
 *
 * The two numbering schemes are NOT the same. The registry preserves the
 * original numbering and has no #3; the property's internal names are a plain
 * sequential list, so everything from Startup Banking onward is off by one:
 *
 *     registry #4  Startup Banking          ->  "3 - Startup Banking"
 *     registry #6  Founder                  ->  "5 - Founder"
 *     registry #18 Startup Marketing & PR   ->  "17 - Startup Marketing & PR Agency"
 *
 * And then the two v2 additions each break the sequence in their own way —
 * which is precisely why guessing them was never safe:
 *
 *     registry #19 Investor      ->  "Investor"           (no numeric prefix at all)
 *     registry #20 Startup GTM   ->  "20 - Startup GTM"   (registry number, not sequential 19)
 */

import { icpByNumber, icpEntries } from "./registry";

/** registry number -> exact HubSpot option string. */
const HUBSPOT_OPTION: Record<number, string> = {
  1: "1 - Recruiting Agency",
  2: "2 - CRE Broker",
  4: "3 - Startup Banking",
  5: "4 - Enterprise AE Selling to Startups",
  6: "5 - Founder",
  7: "6 - Investor Finder Agency",
  8: "7 - Growth Equity / Growth Lending",
  9: "8 - Startup Data Customer",
  10: "9 - Cross-Border Payments",
  11: "10 - Startup HR Platform",
  12: "11 - Startup Insurance",
  13: "12 - Startup Compliance",
  14: "13 - Startup Hiring Platform",
  15: "14 - Startup Accounting",
  16: "15 - Other Startup Agency",
  17: "16 - Startup Legal Services",
  18: "17 - Startup Marketing & PR Agency",
  // The two that break the pattern. Verified from the property, not derived.
  19: "Investor",
  20: "20 - Startup GTM",
};

/**
 * Labels with no option in the property yet.
 *
 * Empty as of the 2026-07-31 verification — every registry label is writable.
 * The mechanism stays because the next ICP added to the registry will land here
 * rather than being silently unwritable, and the build check below enforces
 * that a new label is either mapped or deliberately listed.
 */
export const PENDING_HUBSPOT_OPTIONS: Record<number, string> = {};

export const NOT_CORE_OPTION = "Not Core ICP";

// Build-time: every registry label must be either mapped or explicitly pending.
// A new ICP added to the registry without a decision here fails the build rather
// than silently becoming unwritable at runtime.
for (const e of icpEntries()) {
  if (!HUBSPOT_OPTION[e.number] && !PENDING_HUBSPOT_OPTIONS[e.number]) {
    throw new Error(
      `HubSpot mapping missing for ICP #${e.number} ${e.name}. Add an option or list it as pending.`
    );
  }
}

export type HubspotLabel =
  | { status: "ok"; value: string }
  | { status: "missing_property_option"; value: null; proposed: string; note: string };

export function hubspotLabelFor(icpNumber: number | null): HubspotLabel {
  if (icpNumber === null) return { status: "ok", value: NOT_CORE_OPTION };

  const mapped = HUBSPOT_OPTION[icpNumber];
  if (mapped) return { status: "ok", value: mapped };

  const proposed = PENDING_HUBSPOT_OPTIONS[icpNumber];
  const entry = icpByNumber(icpNumber);
  return {
    status: "missing_property_option",
    value: null,
    proposed: proposed ?? `${icpNumber} - ${entry?.name ?? "unknown"}`,
    note:
      `The HubSpot property has no option for ${entry?.name ?? `ICP #${icpNumber}`}. ` +
      `Add "${proposed}" to the property before writing this label; do not fall back to ` +
      `"${NOT_CORE_OPTION}", which would re-apply the v1 rule that v2 reversed.`,
  };
}
