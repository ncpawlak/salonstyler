import type { ClientPhotoRow } from '@chairside/db';
import { listClients } from '@chairside/db/appointments';
import {
  addClientFormula,
  addClientNote,
  deleteClientFormula,
  deleteClientNote,
  deleteClientOverride,
  deleteClientPhoto,
  getClient,
  getClientSummary,
  listClientFormulas,
  listClientNotes,
  listClientOverrideRows,
  listClientPhotos,
  listClientSummaries,
  listClientVisits,
  saveClientOverride,
  searchClientFormulas,
  toClientServiceOverride,
  updateClient,
  uploadClientPhoto,
  type AddClientFormulaInput,
  type SaveClientOverrideInput,
  type UpdateClientInput,
  type UploadClientPhotoInput,
} from '@chairside/db/clients';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { supabase } from '@/lib/supabase';
import { useCurrentSalon } from '@/providers/session-provider';

import { clientsKey } from '../appointments/api';

function useInvalidateClients() {
  const salon = useCurrentSalon();
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: clientsKey(salon.id) });
}

/**
 * The Clients tab: name/phone/email matches plus clients whose color formulas mention the search
 * ("7N"), each with visit stats. Formula-only matches carry the matching formula.
 */
export function useClientList(search: string) {
  const salon = useCurrentSalon();
  const term = search.trim();
  return useQuery({
    queryKey: [...clientsKey(salon.id), 'list', term],
    queryFn: async () => {
      const [byName, byFormula] = await Promise.all([
        listClients(supabase, salon.id, term),
        term ? searchClientFormulas(supabase, salon.id, term) : Promise.resolve([]),
      ]);
      const formulaFor = new Map<string, string>();
      for (const f of byFormula)
        if (!formulaFor.has(f.clientId)) formulaFor.set(f.clientId, f.formula);
      const known = new Set(byName.map((c) => c.id));
      const extraIds = [...formulaFor.keys()].filter((id) => !known.has(id));
      const extra = extraIds.length
        ? ((await supabase.from('clients').select('*').in('id', extraIds).order('name')).data ?? [])
        : [];
      const clients = [...byName, ...extra];
      const summaries = await listClientSummaries(
        supabase,
        salon.id,
        clients.map((c) => c.id),
      );
      return clients.map((client) => ({
        client,
        summary: summaries.get(client.id) ?? null,
        formulaMatch: known.has(client.id) ? null : (formulaFor.get(client.id) ?? null),
      }));
    },
    placeholderData: (previous) => previous,
  });
}

export function useClient(clientId: string) {
  const salon = useCurrentSalon();
  return useQuery({
    queryKey: [...clientsKey(salon.id), clientId, 'profile'],
    queryFn: () => getClient(supabase, clientId),
  });
}

export function useClientSummary(clientId: string) {
  const salon = useCurrentSalon();
  return useQuery({
    queryKey: [...clientsKey(salon.id), clientId, 'summary'],
    queryFn: () => getClientSummary(supabase, clientId),
  });
}

export function useClientVisits(clientId: string) {
  const salon = useCurrentSalon();
  return useQuery({
    queryKey: [...clientsKey(salon.id), clientId, 'visits'],
    queryFn: () => listClientVisits(supabase, clientId),
  });
}

export function useClientNotes(clientId: string) {
  const salon = useCurrentSalon();
  return useQuery({
    queryKey: [...clientsKey(salon.id), clientId, 'notes'],
    queryFn: () => listClientNotes(supabase, clientId),
  });
}

export function useClientFormulas(clientId: string) {
  const salon = useCurrentSalon();
  return useQuery({
    queryKey: [...clientsKey(salon.id), clientId, 'formulas'],
    queryFn: () => listClientFormulas(supabase, clientId),
  });
}

export function useClientPhotos(clientId: string) {
  const salon = useCurrentSalon();
  return useQuery({
    queryKey: [...clientsKey(salon.id), clientId, 'photos'],
    queryFn: () => listClientPhotos(supabase, clientId),
    // Signed URLs last an hour.
    staleTime: 30 * 60_000,
  });
}

/** Saved duration overrides (rows, for the profile). */
export function useClientOverrideRows(clientId: string | null | undefined) {
  const salon = useCurrentSalon();
  return useQuery({
    queryKey: [...clientsKey(salon.id), clientId, 'overrides'],
    queryFn: () => listClientOverrideRows(supabase, clientId!),
    enabled: !!clientId,
  });
}

/** Saved duration overrides in the shape `resolveSelection` takes; empty until a client is set. */
export function useClientOverrides(clientId: string | null | undefined) {
  const rows = useClientOverrideRows(clientId);
  return { ...rows, data: clientId ? rows.data?.map(toClientServiceOverride) : undefined };
}

export function useUpdateClient(clientId: string) {
  const invalidate = useInvalidateClients();
  return useMutation({
    mutationFn: (input: UpdateClientInput) => updateClient(supabase, clientId, input),
    onSuccess: invalidate,
  });
}

export function useSaveClientOverride() {
  const salon = useCurrentSalon();
  const invalidate = useInvalidateClients();
  return useMutation({
    mutationFn: (input: Omit<SaveClientOverrideInput, 'salonId'>) =>
      saveClientOverride(supabase, { ...input, salonId: salon.id }),
    onSuccess: invalidate,
  });
}

export function useDeleteClientOverride() {
  const invalidate = useInvalidateClients();
  return useMutation({
    mutationFn: (id: string) => deleteClientOverride(supabase, id),
    onSuccess: invalidate,
  });
}

export function useAddClientNote(clientId: string) {
  const salon = useCurrentSalon();
  const invalidate = useInvalidateClients();
  return useMutation({
    mutationFn: (body: string) => addClientNote(supabase, { salonId: salon.id, clientId, body }),
    onSuccess: invalidate,
  });
}

export function useDeleteClientNote() {
  const invalidate = useInvalidateClients();
  return useMutation({
    mutationFn: (id: string) => deleteClientNote(supabase, id),
    onSuccess: invalidate,
  });
}

export function useAddClientFormula(clientId: string) {
  const salon = useCurrentSalon();
  const invalidate = useInvalidateClients();
  return useMutation({
    mutationFn: (input: Omit<AddClientFormulaInput, 'salonId' | 'clientId'>) =>
      addClientFormula(supabase, { ...input, salonId: salon.id, clientId }),
    onSuccess: invalidate,
  });
}

export function useDeleteClientFormula() {
  const invalidate = useInvalidateClients();
  return useMutation({
    mutationFn: (id: string) => deleteClientFormula(supabase, id),
    onSuccess: invalidate,
  });
}

export function useUploadClientPhoto(clientId: string) {
  const salon = useCurrentSalon();
  const invalidate = useInvalidateClients();
  return useMutation({
    mutationFn: (input: Omit<UploadClientPhotoInput, 'salonId' | 'clientId'>) =>
      uploadClientPhoto(supabase, { ...input, salonId: salon.id, clientId }),
    onSuccess: invalidate,
  });
}

export function useDeleteClientPhoto() {
  const invalidate = useInvalidateClients();
  return useMutation({
    mutationFn: (photo: Pick<ClientPhotoRow, 'id' | 'storage_path'>) =>
      deleteClientPhoto(supabase, photo),
    onSuccess: invalidate,
  });
}
