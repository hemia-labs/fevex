/** How long a run lease stays valid before it must be renewed. */
export const LEASE_MS = 30_000;

/** How often a running execution renews its lease. */
export const LEASE_RENEW_MS = 10_000;

/** Reserved name of the internal elicitation tool exposed to the model. */
export const ELICIT_TOOL_NAME = 'fevex__elicit';

/** Reserved name of the internal progressive skill loader exposed to the model. */
export const LOAD_SKILL_TOOL_NAME = 'fevex__load_skill';

/** Reserved name of the internal on-demand tool search exposed to the model. */
export const SEARCH_TOOLS_TOOL_NAME = 'fevex__search_tools';
