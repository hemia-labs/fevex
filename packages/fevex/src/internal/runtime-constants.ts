/** How long a run lease stays valid before it must be renewed. */
export const LEASE_MS = 30_000;

/** How often a running execution renews its lease. */
export const LEASE_RENEW_MS = 10_000;

/** Reserved name of the internal elicitation tool exposed to the model. */
export const ELICIT_TOOL_NAME = 'fevex__elicit';
