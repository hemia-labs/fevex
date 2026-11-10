---
"@fevex/sqlite": minor
---

Add `createSQLiteChannelStore` for durable channel event deduplication and
delivery receipts. Schema v5 adds the `channel_events` and `channel_deliveries`
tables and indexes.
