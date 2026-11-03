# Architecture

This document is for engineers reviewing the code. For a general overview, start with the [README](../README.md).

## Layers

| Folder | Responsibility |
|---|---|
| `src/core/` | Pure business logic: state machine, availability, multi-appointment decisions |
| `src/agent/` | Firewall, classifier, prompts, output validation, style checks |
| `src/service/` | Orchestration: the conversation pipeline, outbox executor, scheduler, integrations |
| `src/api/` | Fastify routes: webhooks, cron endpoints, panel |
| `src/panel/` | Operator panel: session handling, queries, and page |
| `src/config/` | YAML loading and strict validation for each clinic |
| `src/db/` | Drizzle schema, queries, and SQL migrations (RLS, triggers, retention) |
| `tests/` | Unit, service, API, and tenant isolation tests, run against real Postgres |
| `scripts/` | Demo, manual chat bench, AI evaluation, conversation batch test |
| `config/clientes/` | One YAML file per clinic. The only file included is a fictional example |
| `legacy/n8n-workflows/` | Sanitized exports of the retired n8n layer |

## The message pipeline

The main code is `procesarMensajeEntrante` in `src/service/pipeline.ts`.

1. **Idempotency and normalization.** A repeated webhook gets the stored response.
2. **Firewall** (`src/agent/firewall.ts`). Deterministic and evaluated on a recent window of messages, since people split sentences across messages. It is tuned toward false positives. It runs even when a conversation is paused or the agent is switched off.
3. **Classification** (`src/agent/extraccion.ts`). A small model returns a closed schema: intent, service code, preferences, escalation signal, and topic. A service code outside the clinic's catalog becomes `null`, so an invented service cannot create a slot.
4. **Deterministic routing.** Opening hours and clinic facts are composed from YAML with no model. Booking actions are decided by code using the message's form and the current state, not just the classifier's label.
5. **Drafting and validation** (`src/agent/prompt.ts`, `src/agent/output-validation.ts`). A failed draft is regenerated once, then replaced by fixed text and escalated.
6. **Commit and send.** The state change and outgoing messages are saved in one transaction. The executor sends them afterward.

## Key design choices

**Outbox instead of direct writes.** A rollback cannot unsend an email or delete a calendar event. Writes are stored in `motor.outbox` in the turn's transaction and executed afterward by `src/service/ejecutor.ts`.

**Read-only calendar port.** The `Agenda` port can only read busy times, and a convention test enforces that. When automatic booking is on, a separate writer re-checks the slot just before writing and uses a fixed event ID derived from the idempotency key, so a retry cannot create a second event.

**Three failure outcomes when writing an event.** `busy` is a real collision and moves the patient to the next option. `rejected` and `error` mean the system cannot know whether the event exists, so the appointment is left alone and handed to a person.

**Availability has two halves.** Before staff enter an appointment in the clinic's calendar, it exists only in this database. Availability must therefore combine the external calendar and internal state. Skipping internal state once caused the system to re-offer a slot it had just confirmed.

**Database-level protection.** A partial unique index stops two active reservations for one slot, and the code catches that error and offers another slot:

```sql
CREATE UNIQUE INDEX holds_slot_unico
  ON holds (client_id, slot_start)
  WHERE state IN ('retenida', 'pendiente_recepcion', 'confirmada');
```

**Multi-tenant isolation.** Row-Level Security is enabled and forced on every table. The app uses `motor_app`, a role that has no `BYPASSRLS`, owns no tables, and has no `DELETE` permission. The clinic context is set per transaction, and a query without it fails with error `42501` instead of returning nothing. `core.comprobarAislamiento()` checks all of this at startup, and the server will not start if a check fails.

**Time comes from the query, not the cron job.** Expired proposals and past appointments are filtered at read time through one shared definition (`sigueVivo`). A stopped scheduler therefore cannot make old data look valid.

**Clinic differences are configuration.** Each clinic's YAML is validated strictly when the server starts, so a misspelled key stops startup with a clear message.

## Testing approach

- Convention tests (`tests/convenciones.test.ts`) enforce some rules across the code. For example, the calendar port stays read-only, and every function that creates an escalation also emits it.
- Protections that live in the database have concurrent tests. A sequential test would be solved by application code before reaching the constraint.
- `npm run eval` checks the AI evaluation set offline. `npm run tanda` runs ordinary conversations through the real model to measure how much correct output the validation rejects. It needs an API key and costs money, so it is optional.

## Spanish-to-English glossary

The code and comments use Spanish domain terms and English for general programming terms.

| Spanish | English |
|---|---|
| `cita` | appointment |
| `hueco` / `hold` | time slot / reservation of a slot |
| `propuesta` | proposed |
| `retenida` | held |
| `pendiente_recepcion` | waiting for reception staff |
| `confirmada` | confirmed |
| `colisionada` | collision: the slot was taken |
| `caducada` | expired, with nobody acting |
| `liberada` | released on purpose |
| `cortafuegos` | safety firewall |
| `escalado` | escalation to a person |
| `recepción` | reception staff |
| `paciente` / `clínica` | patient / clinic (tenant) |
| `baja` | unsubscribe request |
| `oleada` | outbound reactivation campaign |
| `núcleo` | core service |
| `agenda` | calendar |
| `redactor` / `clasificador` | writing model / classifier model |
| `tanda` | batch test |
| `pimienta` | pepper, the HMAC secret |
