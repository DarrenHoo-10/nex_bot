import { toolFields } from "./tool-fields.ts";

// Providers must see every accepted field, not just an open-ended `action` object.
// Keep flat calls compatible; action-specific requirements/help stay in tool.search.
export const brokerDescription = "Call an authorized Core action. Pass action and its fields at the top level. Common actions are in the system prompt. For other actions or unfamiliar arguments, call tool.search(query) first; use a Chinese purpose, action name or family (e.g. routine). Empty query lists authorized actions; offset/limit paginate. Discovery does not grant permission. Confirm effects only after successful results.";
export const brokerParameters = toolFields;
/** Exactly the declaration registered by the worker and counted in context budgets. */
export const brokerDeclaration = [{ name: "broker", description: brokerDescription, parameters: brokerParameters }];
