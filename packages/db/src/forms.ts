import type { FormAnswers, FormField } from '@chairside/core/forms';

import type { Database } from './database.types.ts';
import type { ChairsideClient, Json } from './index.ts';

/**
 * Intake & consent forms (#45): the salon's form templates, which services require them, the
 * forms a client signed, and the client's signed-out forms link (/f/{manage token}).
 * See supabase/docs/client-forms.md.
 */

type PublicSchema = Database['public'];
type TemplateRow = PublicSchema['Tables']['form_templates']['Row'];
type SubmissionRow = PublicSchema['Tables']['form_submissions']['Row'];

export type FormTemplate = Omit<TemplateRow, 'fields'> & { fields: FormField[] };
export type FormSubmission = Omit<SubmissionRow, 'fields' | 'answers'> & {
  fields: FormField[];
  answers: FormAnswers;
};
/** Profile list: no fields or answers (the signature can be large). */
export type FormSubmissionSummary = Pick<
  SubmissionRow,
  'id' | 'template_id' | 'template_name' | 'appointment_id' | 'submitted_at'
>;

export interface FormTemplateInput {
  name: string;
  description: string | null;
  fields: FormField[];
  ask_new_clients: boolean;
  valid_days: number | null;
}

const TEMPLATE_COLUMNS =
  'id, salon_id, name, description, fields, ask_new_clients, valid_days, starter_key, created_at, updated_at';

const toTemplate = (row: TemplateRow): FormTemplate => ({
  ...row,
  fields: row.fields as unknown as FormField[],
});

const asJson = (fields: FormField[]) => fields as unknown as NonNullable<Json>;

// --- Templates (Settings → Forms) --------------------------------------------------------------

export async function listFormTemplates(
  client: ChairsideClient,
  salonId: string,
): Promise<FormTemplate[]> {
  const { data, error } = await client
    .from('form_templates')
    .select(TEMPLATE_COLUMNS)
    .eq('salon_id', salonId)
    .order('created_at')
    .order('id');
  if (error) throw error;
  return data.map(toTemplate);
}

export async function getFormTemplate(
  client: ChairsideClient,
  templateId: string,
): Promise<FormTemplate | null> {
  const { data, error } = await client
    .from('form_templates')
    .select(TEMPLATE_COLUMNS)
    .eq('id', templateId)
    .maybeSingle();
  if (error) throw error;
  return data ? toTemplate(data) : null;
}

/** Owners only (RLS). */
export async function createFormTemplate(
  client: ChairsideClient,
  salonId: string,
  input: FormTemplateInput,
): Promise<FormTemplate> {
  const { data, error } = await client
    .from('form_templates')
    .insert({ ...input, salon_id: salonId, fields: asJson(input.fields) })
    .select(TEMPLATE_COLUMNS)
    .single();
  if (error) throw error;
  return toTemplate(data);
}

/** Owners only (RLS). Past signatures keep the form as it was when signed. */
export async function updateFormTemplate(
  client: ChairsideClient,
  templateId: string,
  changes: Partial<FormTemplateInput>,
): Promise<FormTemplate> {
  const { fields, ...rest } = changes;
  const { data, error } = await client
    .from('form_templates')
    .update({ ...rest, ...(fields ? { fields: asJson(fields) } : {}) })
    .eq('id', templateId)
    .select(TEMPLATE_COLUMNS)
    .single();
  if (error) throw error;
  return toTemplate(data);
}

/** Owners only (RLS). Signed copies stay on client profiles. */
export async function deleteFormTemplate(
  client: ChairsideClient,
  templateId: string,
): Promise<void> {
  const { error } = await client.from('form_templates').delete().eq('id', templateId);
  if (error) throw error;
}

/** Puts back any starter form the owner deleted; returns how many were added. */
export async function installStarterForms(
  client: ChairsideClient,
  salonId: string,
): Promise<number> {
  const { data, error } = await client.rpc('install_starter_forms', { p_salon_id: salonId });
  if (error) throw error;
  return data;
}

// --- Which services require which forms ---------------------------------------------------------

export interface ServiceFormRequirement {
  service_id: string;
  template_id: string;
}

export async function listServiceFormRequirements(
  client: ChairsideClient,
  salonId: string,
): Promise<ServiceFormRequirement[]> {
  const { data, error } = await client
    .from('service_form_requirements')
    .select('service_id, template_id')
    .eq('salon_id', salonId);
  if (error) throw error;
  return data;
}

/** Owners only (RLS). */
export async function setServiceFormRequired(
  client: ChairsideClient,
  salonId: string,
  serviceId: string,
  templateId: string,
  required: boolean,
): Promise<void> {
  const { error } = required
    ? await client
        .from('service_form_requirements')
        .upsert(
          { salon_id: salonId, service_id: serviceId, template_id: templateId },
          { onConflict: 'service_id,template_id', ignoreDuplicates: true },
        )
    : await client
        .from('service_form_requirements')
        .delete()
        .eq('service_id', serviceId)
        .eq('template_id', templateId);
  if (error) throw error;
}

// --- An appointment's forms (appointment sheet, Today) ------------------------------------------

/** private.appointment_form_status */
export interface AppointmentFormStatus {
  templateId: string;
  name: string;
  done: boolean;
  submittedAt: string | null;
  submissionId: string | null;
}

export async function getAppointmentForms(
  client: ChairsideClient,
  appointmentId: string,
): Promise<AppointmentFormStatus[]> {
  const { data, error } = await client.rpc('appointment_forms', {
    p_appointment_id: appointmentId,
  });
  if (error) throw error;
  return data as unknown as AppointmentFormStatus[];
}

export interface AppointmentMissingForms {
  appointmentId: string;
  clientId: string;
  clientName: string;
  phone: string | null;
  email: string | null;
  startsAt: string;
  status: string;
  services: string | null;
  manageToken: string;
  missing: string[];
}

/** Upcoming appointments in [from, to) (at most 31 days) still missing a required form. */
export async function getAppointmentsMissingForms(
  client: ChairsideClient,
  salonId: string,
  from: Date,
  to: Date,
): Promise<AppointmentMissingForms[]> {
  const { data, error } = await client.rpc('appointments_missing_forms', {
    p_salon_id: salonId,
    p_from: from.toISOString(),
    p_to: to.toISOString(),
  });
  if (error) throw error;
  return data as unknown as AppointmentMissingForms[];
}

// --- Signed forms on the client profile ---------------------------------------------------------

export async function listClientFormSubmissions(
  client: ChairsideClient,
  clientId: string,
): Promise<FormSubmissionSummary[]> {
  const { data, error } = await client
    .from('form_submissions')
    .select('id, template_id, template_name, appointment_id, submitted_at')
    .eq('client_id', clientId)
    .order('submitted_at', { ascending: false });
  if (error) throw error;
  return data;
}

export async function getFormSubmission(
  client: ChairsideClient,
  submissionId: string,
): Promise<FormSubmission | null> {
  const { data, error } = await client
    .from('form_submissions')
    .select(
      'id, salon_id, client_id, template_id, appointment_id, template_name, fields, answers, submitted_at',
    )
    .eq('id', submissionId)
    .maybeSingle();
  if (error) throw error;
  return data
    ? {
        ...data,
        fields: data.fields as unknown as FormField[],
        answers: data.answers as unknown as FormAnswers,
      }
    : null;
}

// --- The client's forms link (/f/{token}, signed out) -------------------------------------------

export interface PublicForm {
  templateId: string;
  name: string;
  description: string | null;
  fields: FormField[];
  done: boolean;
  submittedAt: string | null;
}

export interface PublicAppointmentForms {
  salon: { name: string; slug: string; timezone: string };
  clientFirstName: string | null;
  startsAt: string;
  services: string | null;
  forms: PublicForm[];
}

/** Null when the link is wrong or the appointment was cancelled. */
export async function getPublicAppointmentForms(
  client: ChairsideClient,
  token: string,
): Promise<PublicAppointmentForms | null> {
  const { data, error } = await client.rpc('public_appointment_forms', { p_token: token });
  if (error) throw error;
  return (data as unknown as PublicAppointmentForms | null) ?? null;
}

export type SubmitPublicFormResult =
  | { ok: true; submissionId?: string; submittedAt: string; alreadyDone?: boolean }
  | {
      ok: false;
      reason: 'not_found' | 'not_required' | 'invalid' | 'limit';
      message?: string;
    };

export async function submitPublicForm(
  client: ChairsideClient,
  token: string,
  templateId: string,
  answers: FormAnswers,
): Promise<SubmitPublicFormResult> {
  const { data, error } = await client.rpc('submit_public_form', {
    p_token: token,
    p_template_id: templateId,
    p_answers: answers as unknown as Json,
  });
  if (error) throw error;
  return data as unknown as SubmitPublicFormResult;
}

/** The link the client fills forms at; the same token as their manage link. */
export function formsUrl(origin: string, manageToken: string): string {
  return `${origin.replace(/\/+$/, '')}/f/${manageToken}`;
}
