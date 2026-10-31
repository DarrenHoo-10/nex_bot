import { Type } from "typebox";

// Existing flat calls remain compatible. Per-action schemas come from tool.search.
export const brokerDescription = "Call an authorized Core action. Pass action and its fields at the top level. Common actions are in the system prompt. For other actions or unfamiliar arguments, call tool.search(query) first; use a Chinese purpose, action name or family (e.g. routine). Empty query lists authorized actions; offset/limit paginate. Discovery does not grant permission. Confirm effects only after successful results.";
export const brokerParameters = Type.Object({ action: Type.String() }, { additionalProperties: true });
/** Exactly the declaration registered by the worker and counted in context budgets. */
export const brokerDeclaration = [{ name: "broker", description: brokerDescription, parameters: brokerParameters }];
