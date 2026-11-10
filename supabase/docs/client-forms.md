# Intake & consent forms (#45)

Salons build simple forms (text, choice, checkbox, signature). Clients fill them out and sign on their phone from a signed-out link before their visit. Each signed form is stored on the client's profile with a timestamp, and Today and the appointment sheet flag visits that still need one. Forms are **off by default**: two starter templates are installed for every salon, but none is asked for until the owner turns it on.

Migration: `migrations/20261109400000_client_forms.sql`. Tests: `tests/database/23_client_forms.test.sql`. Shared logic: `@chairside/core/forms` (field and answer validation, signature paths) and `@chairside/db/forms`. App: `apps/mobile/src/features/forms`, Settings → Forms (`app/(app)/settings/forms`), and the client page `app/f/[token].tsx`.

## Tables

| Table | What it holds |
| --- | --- |
| `form_templates` | The salon's forms: `name`, `description`, `fields` (jsonb), `ask_new_clients`, `valid_days`, `starter_key`. Members read; owners write. |
| `service_form_requirements` | `(service_id, template_id)`: this service needs this form. Owners write. |
| `form_submissions` | A signed form: `client_id`, `template_id` (null once the template is deleted), `appointment_id`, and snapshots of `template_name` and `fields`, plus `answers` and `submitted_at`. Members read. **No direct writes**: only `submit_public_form` inserts. |

`fields` is an array of `{ id, kind, label, required?, help?, multiline?, options? }`. `kind` is `text | choice | checkbox | signature`. `private.valid_form_fields` enforces 1–40 fields with unique `^[a-z0-9_]{1,40}$` ids, and choice fields need 2–20 distinct options. Answers are keyed by field id: text and choice are strings, checkboxes are booleans, and a signature is SVG path data (`M x y L x y …`, at most 40,000 characters). `private.form_answers_error` mirrors `formAnswersError` in core, so the page and the database reject the same input.

A submission keeps the form as it was when signed. Editing or deleting a template never changes what a client signed.

## Starter templates

`private.install_starter_forms(salon)` adds **New Client Intake** (allergies, health, last color, hair history, goals, photo consent, signature) and **Color Consent / Patch Test** (previous reactions, patch test, understanding risks and results, signature; re-signed every 182 days). It's idempotent (`unique (salon_id, starter_key)`) and runs for every existing salon in the migration and for new salons via an `after insert` trigger. Owners can re-add a deleted starter from Settings → Forms (`public.install_starter_forms`).

## Which forms a visit needs

`private.appointment_form_status(appointment)` returns one entry per needed form:

- every form linked to a booked service (combo items count too);
- every form with `ask_new_clients`, if this is the client's **first visit**: no earlier appointment that's `completed`, or `confirmed` and already started.

Walk-ins (no client) need nothing. A form counts as **done** when the client has a submission for that template that's still valid:

| `valid_days` | Done when |
| --- | --- |
| `null` (Once) | They've ever signed it. |
| `0` (Every visit) | They signed it for this appointment. |
| `N` | They signed it within N days before the appointment starts. |

Member RPCs:

- `appointment_forms(appointment_id)`: the status list above (appointment sheet → Forms).
- `appointments_missing_forms(salon_id, from, to)`: held, requested and confirmed appointments in a window of at most 31 days that are still missing something (Today → **Forms needed**, next 7 days).

## The client's forms link

`/f/<manage token>` uses the same token as the manage link `/m/<token>` ([client-self-service.md](client-self-service.md)), so nothing new has to be stored or sent. The page is signed out and calls two RPCs granted to `anon`, the same way `get_receipt` works:

- `public_appointment_forms(token)` returns the salon, the client's first name, the appointment time and services, and each needed form with its fields and done state. Returns null for an unknown token or a cancelled or no-show appointment.
- `submit_public_form(token, template_id, answers)` validates the answers, strips nulls, inserts the submission, and writes the audit row `client_forms.submitted`. Results:
  - `{ ok: true, submissionId, submittedAt }`;
  - `{ ok: true, alreadyDone: true }` when it's already signed;
  - `{ ok: false, reason }`, where `reason` is `not_found`, `not_required`, `invalid` (with a client-readable `message`), or `limit`.

Submissions are rate-limited to 30 per token per hour (`private.forms_rate_limit_ok`, in `private.rate_limits`).

The manage page shows a **Fill out forms** banner while something is left to sign.

## Sending the link

- **Email.** When an appointment becomes `confirmed` (booked confirmed, or confirmed from held/requested; not imports) and a form is missing, the trigger `appointments_enqueue_forms_request` queues a `forms_request` client email, deduplicated per appointment. It goes out through the existing client email outbox and `send-client-emails`, so it needs client emails on and a client email address. It has no calendar invite. Like reminders, it's skipped if the appointment moved or is no longer confirmed by send time.
- **Text.** Today → **Forms needed** and appointment sheet → Forms → **Text forms link** open Messages with the link filled in (Copy on web).

## Settings

- **Settings → Forms**: list, create, edit and delete forms; add the starter forms back; per-form **Ask every new client** and **How often** (Once, Every visit, Every 6 months, Every year).
- **Service editor → Forms**: toggle which forms that service requires (e.g. Color Consent on color services).

Signed forms are on the client profile under **Forms**. Tap one to see the answers and signature.
