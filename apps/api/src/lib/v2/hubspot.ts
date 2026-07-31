/**
 * Registry label -> HubSpot picklist option.
 *
 * These two numbering schemes are NOT the same, and assuming they were would
 * write the wrong segment onto real contacts. The registry preserves the
 * original numbering and has no #3; the HubSpot property was built as a plain
 * sequential list, so everything from Startup Banking onward is off by one:
 *
 *     registry #4  Startup Banking          ->  "3 - Startup Banking"
 *     registry #6  Founder                  ->  "5 - Founder"
 *     registry #18 Startup Marketing & PR   ->  "17 - Startup Marketing & PR Agency"
 *
 * Two labels have no option at all. #19 Investor and #20 Startup GTM are v2
 * additions — #19 in particular REVERSES the v1 rule that investors are Not
 * Core — and the property predates both. Rather than guess, those return null
 * with a status the caller can branch on: writing "Not Core ICP" for an
 * investor would silently re-apply the exact rule v2 overturned.
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
};

/** Labels that need a new option added to the HubSpot property before they can be written. */
export const PENDING_HUBSPOT_OPTIONS: Record<number, string> = {
  19: "18 - Investor",
  20: "19 - Startup GTM",
};

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
