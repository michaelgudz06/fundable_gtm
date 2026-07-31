import { composeFromTemplate } from "../src/lib/v2/compose";
import { getTemplate, useCasesFor } from "../src/lib/v2/registry";

for (const [tid, icp] of [["followup_mcp", 19], ["followup_api", 19], ["followup_mcp", 9], ["followup_api", 9], ["followup_alerts_paid", 19], ["website_visitor_use_case", 19], ["signup_paid_initial", 2]] as [string, number][]) {
  const t = getTemplate(tid)!;
  const r = composeFromTemplate({ template: t, useCases: useCasesFor(icp), ctx: { first_name: "Reed", sender_name: "Jacob", icp_descriptor: "investing team" } });
  console.log("=== " + tid + " ICP#" + icp + " issues=" + JSON.stringify(r.issues));
  console.log(r.body);
  console.log();
}
