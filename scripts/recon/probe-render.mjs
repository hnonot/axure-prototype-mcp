import { declaredInteraction, inferredInteraction, summarize } from "../../dist/axure/interaction.js";
import { renderInteractions } from "../../dist/axure/interaction-render.js";
const fact = declaredInteraction({ widgetRef: "p1#u1363", widgetId: "u1363", rawTrigger: "onClick" }, {
  eventType: "OnClick",
  cases: [{
    description: "Case 1",
    conditionString: "if is selected of This equals false",
    actions: [{ action: "setFunction", displayName: "Set Selected/Checked", description: "Set is selected of This equal to &quot;true&quot;" }],
  }],
});
const guess = inferredInteraction({ widgetRef: "p1#u47", widgetId: "u47" }, "click", "CSS cursor is pointer");
const interactions = [fact, guess];
const text = renderInteractions({ page: { id: "p1", name: "p", url: "u", title: "t", type: "W", path: [] }, interactions, stats: summarize(interactions, 1119), gaps: [], warnings: [] });
console.log(text.split("\n").filter((l) => l.includes("Case 1") || l.includes("declared")).join("\n"));
console.log("--- structured action ---");
console.log(JSON.stringify(fact.branches[0].actions[0], null, 1));

