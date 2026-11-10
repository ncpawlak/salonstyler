import { bookingRulesFromSettings, buildWorkHours } from '@chairside/core';
import type { ChairsideClient, ClientRow, Json } from '@chairside/db';
import {
  addClient,
  bookAppointment,
  listAppointments,
  listClients,
  setAppointmentStatus,
  type AppointmentServiceSnapshot,
} from '@chairside/db/appointments';
import { addClientFormula, addClientNote, listClientOverrides } from '@chairside/db/clients';
import { getInboxBridge } from '@chairside/db/inbox';
import { getReplySettings } from '@chairside/db/replies';
import { getSalesReport } from '@chairside/db/reports';
import { listServiceMenu } from '@chairside/db/services';
import { getWorkHours } from '@chairside/db/work-hours';

import type { AssistantClient, AssistantPort } from './types.ts';

const toClient = (row: Pick<ClientRow, 'id' | 'name' | 'phone' | 'email'>): AssistantClient => ({
  id: row.id,
  name: row.name,
  phone: row.phone,
  email: row.email,
});

/**
 * The assistant's data access over a Supabase client created with the caller's JWT, so row-level
 * security confines every read and write to salons the caller belongs to. `salonId` only picks
 * which of those salons; it grants nothing by itself.
 */
export function createSupabaseAssistantPort(
  client: ChairsideClient,
  salonId: string,
): AssistantPort {
  return {
    async getSchedule(range) {
      const [hours, salon] = await Promise.all([
        getWorkHours(client, salonId, range),
        client.from('salons').select('name').eq('id', salonId).single(),
      ]);
      if (salon.error) throw salon.error;
      return {
        salonName: salon.data.name,
        hours: buildWorkHours({
          timeZone: hours.timeZone,
          template: hours.template,
          overrides: hours.overrides,
        }),
        rules: bookingRulesFromSettings(hours.bookingRules),
        holdExpiryHours: hours.bookingRules.hold_expiry_hours,
      };
    },

    getMenu: () => listServiceMenu(client, salonId),
    salesReport: (range) => getSalesReport(client, salonId, range),

    async listClients() {
      return (await listClients(client, salonId, undefined, 1000)).map(toClient);
    },

    async getClient(id) {
      const { data, error } = await client
        .from('clients')
        .select('id, name, phone, email')
        .eq('salon_id', salonId)
        .eq('id', id)
        .maybeSingle();
      if (error) throw error;
      return data ? toClient(data) : null;
    },

    async clientVisits(clientId, limit) {
      const { data, error } = await client
        .from('appointments')
        .select('starts_at, status, services')
        .eq('salon_id', salonId)
        .eq('client_id', clientId)
        .order('starts_at', { ascending: false })
        .limit(limit);
      if (error) throw error;
      return data.map((row) => ({
        startsAt: new Date(row.starts_at).toISOString(),
        status: row.status,
        services: (Array.isArray(row.services)
          ? row.services
          : []) as unknown as AppointmentServiceSnapshot[],
      }));
    },

    listAppointments: (range) => listAppointments(client, salonId, range),

    async getAppointment(id) {
      const { data, error } = await client
        .from('appointments')
        .select('starts_at, ends_at')
        .eq('salon_id', salonId)
        .eq('id', id)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      const rows = await listAppointments(
        client,
        salonId,
        {
          from: new Date(data.starts_at).toISOString(),
          to: new Date(Date.parse(new Date(data.ends_at).toISOString()) + 1).toISOString(),
        },
        { includeInactive: true },
      );
      return rows.find((r) => r.id === id) ?? null;
    },

    async bookHeld(input) {
      const row = await bookAppointment(client, {
        salonId,
        clientId: input.clientId,
        segments: input.segments,
        services: input.services,
        status: 'held',
        source: 'owner',
        priceCents: input.priceCents,
        notes: input.notes,
      });
      return { id: row.id, holdExpiresAt: row.hold_expires_at };
    },

    async setStatus(id, status, reason) {
      await setAppointmentStatus(client, id, status, reason);
    },

    clientOverrides: (clientId) => listClientOverrides(client, clientId),

    async addClientNote({ clientId, kind, text }) {
      const row =
        kind === 'formula'
          ? await addClientFormula(client, { salonId, clientId, formula: text })
          : await addClientNote(client, { salonId, clientId, body: text, source: 'ai' });
      return { id: row.id };
    },

    async createClient(input) {
      return toClient(await addClient(client, salonId, input));
    },

    async getReplyContext(requestId) {
      const [settings, bridge, request] = await Promise.all([
        getReplySettings(client, salonId),
        getInboxBridge(client, salonId),
        requestId
          ? client
              .from('captured_requests')
              .select(
                'id, intent, status, sender, sender_phone, message, client_id, appointment_id, target_appointment_id',
              )
              .eq('salon_id', salonId)
              .eq('id', requestId)
              .maybeSingle()
          : null,
      ]);
      if (request?.error) throw request.error;
      const row = request?.data;
      return {
        ...settings,
        bridgeKeyword: bridge?.keyword ?? null,
        request: row
          ? {
              id: row.id,
              intent: row.intent,
              status: row.status,
              sender: row.sender,
              senderPhone: row.sender_phone,
              message: row.message,
              clientId: row.client_id,
              appointmentId: row.appointment_id,
              targetAppointmentId: row.target_appointment_id,
            }
          : null,
      };
    },

    async audit(action, details) {
      const { data: auth } = await client.auth.getUser();
      const { error } = await client.from('audit_log').insert({
        salon_id: salonId,
        actor_user_id: auth.user?.id ?? null,
        action,
        entity_type: 'ai_assistant',
        details: JSON.parse(JSON.stringify(details)) as NonNullable<Json>,
      });
      // Auditing must never break the conversation.
      if (error) console.warn('assistant audit failed', error.message);
    },
  };
}
