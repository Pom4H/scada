# Security

The playground interprets an allow-listed declarative subset of TypeScript. It never evaluates source as JavaScript. Project text cannot access the DOM, network, browser storage, imports outside the DSL, or prototype chains through this interpreter. Source size, AST evaluation and element counts are bounded. These are defense-in-depth design choices, not a formal security certification.

The built site has no telemetry, account service or shared database. Local project text is stored under `scada.source.v1`; clear browser storage to remove it. Shared links contain the complete source in the URL fragment, and exported HTML embeds source. Anyone receiving either can read it. Never share credentials, tokens, personal information or sensitive industrial data.

The supplied scenes use synthetic demonstration state. No PLC or plant-control connection is implemented. Do not connect this playground to operational equipment as a safety or control layer.

For vulnerabilities, use GitHub's private security reporting when available; otherwise contact the maintainer privately before publishing an exploit. Include a minimal reproducer without real credentials or plant data.
