# Security

The playground interprets an allow-listed declarative subset of TypeScript. It never evaluates source as JavaScript. Project text cannot access the DOM, network, browser storage, imports outside the DSL, or prototype chains through this interpreter. Source size, AST evaluation and element counts are bounded. These are defense-in-depth design choices, not a formal security certification.

The built static site has no analytics telemetry or account service. The optional local server stores synthetic runs in SQLite and authorizes bearer tokens with view/operator/research roles. Tokens stay outside project source, shared URLs and browser storage. Runtime declarations are inert until the user explicitly connects to the displayed destination. Local project text is stored under `scada.source.v1`; clear browser storage to remove it. Shared links contain the complete source in the URL fragment, and exported HTML embeds source. Anyone receiving either can read it. Never share credentials, tokens, personal information or sensitive industrial data.

The supplied scenes use synthetic demonstration state. No PLC or plant-control connection is implemented. Do not connect this playground to operational equipment as a safety or control layer.

For vulnerabilities, use GitHub's private security reporting when available; otherwise contact the maintainer privately before publishing an exploit. Include a minimal reproducer without real credentials or plant data.

The demo binds loopback by default, has exact Origin checks, validates commands against installed metadata, bounds request bodies and stream buffers, and serves only files under dist. Browser projects cannot install or execute behavior code. Research truth is available only to the research role; observation consumers must not be given that token. Public user-authored labels are not guaranteed to be blind dataset labels. See docs/server-runtime.md for deployment boundaries and retention limits.
