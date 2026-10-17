# Rakazo presentation sources

Source: https://github.com/elie222/rakazo
Revision: 6191ad23ac2760687bb74ba23da9af9b276fc20e
License: Apache-2.0 (see LICENSE).

Reused files:
- packages/ui-tokens/src/tokens.css → src/personal/vendor/rakazo/tokens.css. Selectors scoped to the NexBot workspace; values unchanged.
- apps/web/src/components/ToolActivityDisclosure.tsx → src/personal/vendor/rakazo/ToolActivityDisclosure.tsx. Extracted the disclosure component, replaced Lingui/Tailwind dependencies with Chinese labels and local CSS; terminal wording does not imply success.

Contact sidebar and connector management are NexBot implementations inspired by Rakazo's layout. No Rakazo backend, branding or authentication is embedded.
