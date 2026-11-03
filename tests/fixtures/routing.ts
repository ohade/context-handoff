// FIXTURE: representative prompt routes, not a copy of any host's routing policy.
export const DOMAIN_ROUTE = /\b(billing|inventory|warehouse|telemetry|subscriptions)\b/i
export const DATA_ROUTE = /\b(data|query|sql|tables?|columns?|fields?|schemas?|lineage|sources?|etl|metrics?|dashboards?|logs?|rows?|counts?|rates?|values?|trends?|figures?|revenue|spend|traffic|click|impression|request|conversion|current|live|production|prod|today|yesterday|week|month|quarter)\b/i
export const EXPLICIT_ROUTE = /(?:\$|\/)?(?:data[- ]reader|code[- ]index|metrics[- ]reader)\b/i
