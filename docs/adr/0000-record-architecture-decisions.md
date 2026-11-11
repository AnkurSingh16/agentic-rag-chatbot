# ADR 0000: Record architecture decisions

## Status

Accepted

## Context

The platform will be embedded in more than one application and will change over time. Decisions about isolation, access control and data handling need to be traceable, so that a later change doesn't quietly undo an earlier safeguard.

## Decision

Record every significant design decision as a numbered Markdown file in `docs/adr`. Each record covers context, options considered, the decision, consequences, and objections that were raised but not resolved.

A decision is significant when it affects a public interface, the data model, security or isolation, cost, or how consumers integrate.

## Consequences

- Design PRs link to their ADR.
- Superseded records stay in place and point to their replacement.
