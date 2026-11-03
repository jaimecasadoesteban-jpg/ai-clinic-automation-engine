# Retired n8n workflows

The first version of this system used n8n as its integration layer. It received WhatsApp webhooks, called the core service, sent replies, and read Google Calendar. These responsibilities later moved into the core service, where they can be tested and retried and where everything they do is logged. The workflows are no longer active.

These files are included for reference only. **`npm run demo` does not use them.**

| File | Purpose |
|---|---|
| `whatsapp-inbound.json` | Verifies the Meta webhook, extracts the message, finds the clinic, calls the core service, and sends the reply and staff alerts |
| `calendar-availability.json` | Exposes busy-time and is-this-slot-free webhooks through Google Calendar's `freeBusy` API |

## How they were sanitized

The exports were rebuilt from a list of allowed fields, so anything not listed was left out:

- Sticky notes, workflow IDs, webhook IDs, version data, and sharing data were removed.
- Hard-coded tokens were replaced with `$env` references.
- Credential references were replaced with `REPLACE_ME` placeholders.
- The phone number ID and internal host name were replaced.

To import a workflow, create your own n8n credentials and set `WHATSAPP_TOKEN`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, and `NUCLEO_API_TOKEN`. New webhook IDs are created when n8n saves them. These sanitized files have not been re-imported and run in n8n.
