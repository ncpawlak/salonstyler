import type { FormAnswers } from '@chairside/core/forms';
import {
  createFormTemplate,
  deleteFormTemplate,
  type FormTemplateInput,
  getAppointmentForms,
  getAppointmentsMissingForms,
  getFormSubmission,
  getFormTemplate,
  getPublicAppointmentForms,
  installStarterForms,
  listClientFormSubmissions,
  listFormTemplates,
  listServiceFormRequirements,
  setServiceFormRequired,
  submitPublicForm,
  updateFormTemplate,
} from '@chairside/db/forms';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { supabase } from '@/lib/supabase';

/** Everything forms-related on members' screens, so one invalidation refreshes them all. */
const ROOT = 'forms';

// --- Templates (Settings → Forms) --------------------------------------------------------------

export function useFormTemplates(salonId: string) {
  return useQuery({
    queryKey: [ROOT, 'templates', salonId],
    queryFn: () => listFormTemplates(supabase, salonId),
  });
}

export function useFormTemplate(templateId: string | undefined) {
  return useQuery({
    queryKey: [ROOT, 'template', templateId],
    queryFn: () => getFormTemplate(supabase, templateId!),
    enabled: !!templateId,
  });
}

function useInvalidateForms() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: [ROOT] });
}

export function useSaveFormTemplate(salonId: string) {
  const invalidate = useInvalidateForms();
  return useMutation({
    mutationFn: ({ id, input }: { id: string | null; input: FormTemplateInput }) =>
      id ? updateFormTemplate(supabase, id, input) : createFormTemplate(supabase, salonId, input),
    onSuccess: invalidate,
  });
}

export function useDeleteFormTemplate() {
  const invalidate = useInvalidateForms();
  return useMutation({
    mutationFn: (id: string) => deleteFormTemplate(supabase, id),
    onSuccess: invalidate,
  });
}

export function useInstallStarterForms(salonId: string) {
  const invalidate = useInvalidateForms();
  return useMutation({
    mutationFn: () => installStarterForms(supabase, salonId),
    onSuccess: invalidate,
  });
}

// --- Per-service "requires form" ---------------------------------------------------------------

export function useServiceFormRequirements(salonId: string) {
  return useQuery({
    queryKey: [ROOT, 'requirements', salonId],
    queryFn: () => listServiceFormRequirements(supabase, salonId),
  });
}

export function useSetServiceFormRequired(salonId: string) {
  const invalidate = useInvalidateForms();
  return useMutation({
    mutationFn: (v: { serviceId: string; templateId: string; required: boolean }) =>
      setServiceFormRequired(supabase, salonId, v.serviceId, v.templateId, v.required),
    onSuccess: invalidate,
  });
}

// --- Appointment, Today and the client profile -------------------------------------------------

export function useAppointmentForms(appointmentId: string | undefined) {
  return useQuery({
    queryKey: [ROOT, 'appointment', appointmentId],
    queryFn: () => getAppointmentForms(supabase, appointmentId!),
    enabled: !!appointmentId,
  });
}

const DAY = 86_400_000;

/** The next week's appointments still missing a required form. */
export function useAppointmentsMissingForms(salonId: string, days = 7) {
  return useQuery({
    queryKey: [ROOT, 'missing', salonId, days],
    queryFn: () => {
      const from = new Date(Date.now() - 2 * 3_600_000);
      return getAppointmentsMissingForms(
        supabase,
        salonId,
        from,
        new Date(from.getTime() + days * DAY),
      );
    },
  });
}

export function useClientFormSubmissions(clientId: string) {
  return useQuery({
    queryKey: [ROOT, 'client', clientId],
    queryFn: () => listClientFormSubmissions(supabase, clientId),
  });
}

export function useFormSubmission(submissionId: string | null) {
  return useQuery({
    queryKey: [ROOT, 'submission', submissionId],
    queryFn: () => getFormSubmission(supabase, submissionId!),
    enabled: !!submissionId,
  });
}

// --- The client's forms link (/f/{token}, signed out) -------------------------------------------

export function usePublicAppointmentForms(token: string) {
  return useQuery({
    queryKey: ['public-forms', token],
    queryFn: () => getPublicAppointmentForms(supabase, token),
    retry: false,
  });
}

export function useSubmitPublicForm(token: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ templateId, answers }: { templateId: string; answers: FormAnswers }) =>
      submitPublicForm(supabase, token, templateId, answers),
    onSuccess: (r) => {
      if (r.ok) void queryClient.invalidateQueries({ queryKey: ['public-forms', token] });
    },
  });
}
