# Design Rules

These rules govern all the code in this project. Code comments refer to them by number ("regla 3" means rule 3). The system handles health-related data, so each rule exists to prevent a specific harm.

## The eight rules

**1. `client_id` is required everywhere.** Every table has it, and every data function takes it as its first parameter with no default. A leak between clinics is the worst possible failure.

**2. Phone numbers never enter a prompt.** The model receives a first name and an internal ID such as `pac_8371`. It never receives a phone number, surname, ID document, medical record, or another patient's data.

**3. A turn does not write to external systems.** Messages, events, and emails are saved to `motor.outbox` with the state change and executed after the commit. The calendar read port has no write method, and a test enforces that. Patients are told an appointment is confirmed only once it exists.

**4. No path ends in silence.** Every error, expiry, or collision produces a message to the patient and, where needed, an escalation. A calendar failure does not lose the turn.

- **4 bis. The message and the system state must match.** Nothing is offered or chosen on an assumption. If the service is unknown, the system asks. A slot being offered is never described as reserved.
- **4 ter. The service is conversation state.** Patients rarely repeat the service name, so it is kept with the conversation, and it expires after the same period as a proposal.
- **4 quater. The agent does not promise what it cannot do.** It lives for one turn, so "I'll check and get back to you" is blocked. In each turn it either presents options or asks for the missing detail.

**5. The model does not decide clinical content.** The firewall is deterministic and runs before any model call. Its replies are fixed and approved by the clinic.

**6. Every message is logged.** That covers incoming and outgoing messages, prompts, responses, model, tokens, latency, and validation results. Prompts are purged after 90 days because they can contain clinical text.

**7. Clinic differences are configuration, never code.** Adding a clinic means adding one YAML file.

**8. A scheduled job records state, but does not define it.** Reads must not trust anything that depends on a cron job having run. Expired items are filtered in the query itself, so an outage cannot make old data look valid.

## Principles behind the rules

- **Bias each control toward its cheaper mistake.** The firewall prefers false positives, because a missed urgent message costs far more than an extra escalation. The classifier's non-clinical escalation signal does the opposite, because too many alerts teach staff to ignore them.
- **Make rules impossible to break, not just easy to remember.** The event for staff confirmation requires a `huecoSigueLibre` field, so the calendar re-read cannot be skipped.
- **Measure both sides of a safety check.** Adversarial tests measure what gets through, and the batch test measures how much correct output gets blocked.
- **A passing test shows the code does what we said, not that what we said is right.** Manual testing found errors of intent that the test suite had certified as correct.
- **Remove the temporary fix when the real one ships.** Old instructions left in a prompt can contradict the new behavior, and validation cannot see that.

## Slot state machine

| State | Blocks the slot | Expiry |
|---|---|---|
| `propuesta` (proposed) | No | 6 hours |
| `retenida` (held) | Yes | 30 minutes |
| `pendiente_recepcion` (waiting for staff) | Yes | Reminder at 2 h, escalation at 4 h, expires at end of day |
| `confirmada` (confirmed) | Yes | None |
| `liberada` (released) | No | None |

Proposals deliberately do not block a slot. Offering three times to five people should not take fifteen slots away from a clinic.

## Data retention

| Data | Period | When it expires |
|---|---|---|
| Clinical messages | 90 days | Content is redacted, telemetry remains |
| Messages and conversations | 12 months | Content is redacted, telemetry remains |
| All detail | 24 months | Rows are deleted, only after the period is consolidated |
| Audit log | 12 months | Deleted |
| Idempotency keys | 30 days | Deleted |
| Unsubscribe register | Indefinite | Never deleted |

## The suppression pepper

The unsubscribe table does not store phone numbers. It stores an HMAC-SHA256 of the number, keyed with `SUPPRESSION_PEPPER`, so it can answer "has this number opted out?" without being a directory of phone numbers. The pepper cannot be rotated, because the original numbers are not kept, so it must be stored safely outside the server.

## Onboarding a clinic

Copy `config/clientes/ejemplo.yaml` and fill it in with information from the clinic. Nothing is filled in with an assumed value.

**Required, or the server will not start:** clinic name and WhatsApp line ID, time zone, opening hours, the service catalog with exact prices and durations, reception contacts, escalation contacts, a data-protection contact, the agenda level, and the calendar ID.

**Knowledge base, used word for word without a model:** address, parking, payment methods, cancellation policy, first-visit details, and preparation for each service. Missing facts are referred to reception, so they are never invented. The clinic writes and approves this text.

**Decisions to ask the clinic about:** calendar access, which calendar reception really uses (automatic booking is only valid if it is the same one), what appears in calendar events, the fixed safety messages, and the tone of voice.

Values marked `!ejemplo` in the file are invented, and the server warns at startup for each one that remains.
