import { formatDuration, type WorkHours } from '@chairside/core';
import type { AppointmentStatus } from '@chairside/db';
import type { AppointmentWithDetails } from '@chairside/db/appointments';
import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { Badge, Button, Sheet, Text, type BadgeTone } from '@/components/ui';
import { haptics } from '@/lib/haptics';

import { formatPrice } from '../services/data';
import { errorMessage, useSetAppointmentStatus } from './api';
import { formatDay, formatTime } from './format';
import type { MoveResult } from './use-move';

const STATUS: Record<AppointmentStatus, { label: string; tone: BadgeTone }> = {
  held: { label: 'Hold', tone: 'warning' },
  requested: { label: 'Requested', tone: 'warning' },
  confirmed: { label: 'Confirmed', tone: 'primary' },
  completed: { label: 'Completed', tone: 'success' },
  cancelled: { label: 'Cancelled', tone: 'destructive' },
  no_show: { label: 'No-show', tone: 'destructive' },
};

export interface AppointmentSheetProps {
  appointment: AppointmentWithDetails | null;
  onClose: () => void;
  hours: WorkHours;
  gridMinutes: number;
  onMove: (appt: AppointmentWithDetails, deltaMinutes: number) => Promise<MoveResult>;
  onEditServices: (appt: AppointmentWithDetails) => void;
}

export function AppointmentSheet({ appointment, onClose, ...rest }: AppointmentSheetProps) {
  return (
    <Sheet
      open={!!appointment}
      onOpenChange={(open) => !open && onClose()}
      title={appointment ? (appointment.client?.name ?? 'Walk-in') : undefined}
      subtitle={
        appointment
          ? `${formatDay(Date.parse(appointment.starts_at), rest.hours.timeZone)}`
          : undefined
      }
    >
      {appointment ? (
        <AppointmentDetails
          key={appointment.id}
          appointment={appointment}
          onClose={onClose}
          {...rest}
        />
      ) : null}
    </Sheet>
  );
}

function AppointmentDetails({
  appointment,
  onClose,
  hours,
  gridMinutes,
  onMove,
  onEditServices,
}: Omit<AppointmentSheetProps, 'appointment'> & { appointment: AppointmentWithDetails }) {
  const tz = hours.timeZone;
  const setStatus = useSetAppointmentStatus();
  // Status shown here survives the appointment dropping off the calendar (cancel/no-show).
  const [status, setLocalStatus] = useState<AppointmentStatus>(appointment.status);
  const [previous, setPrevious] = useState<AppointmentStatus | null>(null);
  const [delta, setDelta] = useState(0);
  const [moving, setMoving] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone: 'destructive' | 'muted' } | null>(
    null,
  );

  const start = Date.parse(appointment.starts_at);
  const end = Date.parse(appointment.ends_at);
  const shift = delta * 60_000;
  const minutes = Math.round((end - start) / 60_000);
  const services = appointment.services
    .map((s) => (s.variantName ? `${s.name} (${s.variantName})` : s.name))
    .join(' + ');
  const busy = setStatus.isPending || moving;
  const active = status === 'held' || status === 'requested' || status === 'confirmed';

  const change = async (next: AppointmentStatus, undo = false) => {
    setMessage(null);
    try {
      await setStatus.mutateAsync({ id: appointment.id, status: next });
      if (next === 'cancelled') haptics.warning();
      else haptics.success();
      setPrevious(undo ? null : status);
      setLocalStatus(next);
      setConfirmCancel(false);
      if (next === 'cancelled') onClose();
    } catch (e) {
      haptics.error();
      setMessage({ text: errorMessage(e), tone: 'destructive' });
    }
  };

  const saveTime = async () => {
    setMoving(true);
    setMessage(null);
    const result = await onMove(appointment, delta);
    setMoving(false);
    if (result.ok) {
      haptics.success();
      setDelta(0);
      if (result.warning) setMessage({ text: result.warning, tone: 'muted' });
      else onClose();
    } else {
      haptics.error();
      setMessage({ text: result.message, tone: 'destructive' });
    }
  };

  return (
    <View className="gap-5">
      <View className="gap-1.5">
        <View className="flex-row items-center gap-2">
          <Badge label={STATUS[status].label} tone={STATUS[status].tone} />
          <Text variant="subhead" numeric>
            {formatTime(start, tz)} – {formatTime(end, tz)} · {formatDuration(minutes)}
          </Text>
        </View>
        <Text variant="body">{services || 'No services'}</Text>
        {appointment.price_cents != null ? (
          <Text variant="subhead" tone="muted">
            {formatPrice(appointment.price_cents)}
          </Text>
        ) : null}
        {appointment.client?.phone ? (
          <Text variant="subhead" tone="muted">
            {appointment.client.phone}
          </Text>
        ) : null}
        {status === 'held' && appointment.hold_expires_at ? (
          <Text variant="footnote" tone="muted">
            Hold releases {formatDay(Date.parse(appointment.hold_expires_at), tz)} at{' '}
            {formatTime(Date.parse(appointment.hold_expires_at), tz)} unless confirmed.
          </Text>
        ) : null}
      </View>

      {active ? (
        <View className="gap-2">
          <Text variant="headline">Move</Text>
          <View className="flex-row items-center gap-3 rounded-xl bg-card px-2 py-1.5">
            <Button
              variant="ghost"
              size="icon"
              icon="remove"
              accessibilityLabel={`${gridMinutes} minutes earlier`}
              onPress={() => {
                haptics.selection();
                setDelta((d) => d - gridMinutes);
              }}
            />
            <Text variant="headline" numeric className="flex-1 text-center">
              {formatTime(start + shift, tz)} – {formatTime(end + shift, tz)}
            </Text>
            <Button
              variant="ghost"
              size="icon"
              icon="add"
              accessibilityLabel={`${gridMinutes} minutes later`}
              onPress={() => {
                haptics.selection();
                setDelta((d) => d + gridMinutes);
              }}
            />
          </View>
          {delta !== 0 ? (
            <View className="flex-row gap-3">
              <Button variant="secondary" label="Reset" grow onPress={() => setDelta(0)} />
              <Button
                label="Save time"
                icon="time-outline"
                grow
                loading={moving}
                disabled={busy}
                onPress={saveTime}
              />
            </View>
          ) : (
            <Text variant="footnote" tone="muted">
              Or hold and drag it on the calendar.
            </Text>
          )}
        </View>
      ) : null}

      {message ? (
        <View
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          className={
            message.tone === 'destructive'
              ? 'rounded-xl bg-destructive/10 px-4 py-3'
              : 'rounded-xl bg-muted px-4 py-3'
          }
        >
          <Text variant="subhead" tone={message.tone}>
            {message.text}
          </Text>
        </View>
      ) : null}

      <View className="gap-3">
        {status === 'held' || status === 'requested' ? (
          <Button
            label="Confirm"
            icon="checkmark-circle-outline"
            fullWidth
            disabled={busy}
            onPress={() => change('confirmed')}
          />
        ) : null}
        {status === 'confirmed' || status === 'completed' ? (
          <Button
            label={status === 'completed' ? 'Checkout & receipt' : 'Checkout'}
            icon="card-outline"
            fullWidth
            disabled={busy}
            onPress={() => {
              onClose();
              router.push(`/checkout/${appointment.id}`);
            }}
          />
        ) : null}
        {status === 'confirmed' ? (
          <View className="flex-row gap-3">
            <Button
              variant="secondary"
              label="Completed"
              icon="checkmark-done-outline"
              grow
              disabled={busy}
              onPress={() => change('completed')}
            />
            <Button
              variant="secondary"
              label="No-show"
              icon="eye-off-outline"
              grow
              disabled={busy}
              onPress={() => change('no_show')}
            />
          </View>
        ) : null}
        {(status === 'completed' || status === 'no_show') && previous === 'confirmed' ? (
          <Button
            variant="secondary"
            label={`Undo ${STATUS[status].label.toLowerCase()}`}
            icon="arrow-undo-outline"
            fullWidth
            disabled={busy}
            onPress={() => change('confirmed', true)}
          />
        ) : null}
        {active ? (
          <Button
            variant="secondary"
            label="Edit services"
            icon="cut-outline"
            fullWidth
            disabled={busy}
            onPress={() => onEditServices(appointment)}
          />
        ) : null}
        {active ? (
          confirmCancel ? (
            <View className="gap-2">
              <Text variant="subhead" tone="muted">
                Cancel this appointment and free the time?
              </Text>
              <View className="flex-row gap-3">
                <Button
                  variant="secondary"
                  label="Keep"
                  grow
                  onPress={() => setConfirmCancel(false)}
                />
                <Button
                  variant="destructive"
                  label="Yes, cancel"
                  grow
                  loading={setStatus.isPending}
                  onPress={() => change('cancelled')}
                />
              </View>
            </View>
          ) : (
            <Button
              variant="ghost"
              label="Cancel appointment"
              icon="close-circle-outline"
              fullWidth
              disabled={busy}
              onPress={() => setConfirmCancel(true)}
            />
          )
        ) : null}
      </View>
    </View>
  );
}
