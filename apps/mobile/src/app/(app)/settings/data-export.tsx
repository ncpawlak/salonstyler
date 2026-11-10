import type { DataExportResponse, DataImportResponse } from '@chairside/db/data-export';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as DocumentPicker from 'expo-document-picker';
import { Platform, Share, View } from 'react-native';

import { DetailScreen } from '@/components/shell/screen';
import { Button, Card, EmptyState, SectionHeader, Text } from '@/components/ui';
import { errorMessage } from '@/features/appointments/api';
import { exportSalonData, restoreSalonData, summarizeCounts } from '@/features/data-export/api';
import { readPickedBytes } from '@/features/import/api';
import { useCurrentSalon } from '@/providers/session-provider';

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/**
 * Settings → Export your data (#46). One tap builds a zip of everything the salon owns (CSV +
 * data.json + photos and receipts), emails the owner a 24-hour link and offers a 1-hour link to share now.
 */
export default function DataExportScreen() {
  const salon = useCurrentSalon();
  const queryClient = useQueryClient();
  const isOwner = salon.role === 'owner';

  const exporter = useMutation<DataExportResponse>({
    mutationFn: () => exportSalonData(salon.id),
  });
  const restorer = useMutation<DataImportResponse | null>({
    mutationFn: async () => {
      const picked = await DocumentPicker.getDocumentAsync({
        type: ['application/zip', 'application/x-zip-compressed', 'application/json'],
        copyToCacheDirectory: true,
        multiple: false,
      });
      const asset = picked.canceled ? null : picked.assets[0];
      if (!asset) return null;
      const bytes = await readPickedBytes(asset.uri, asset.file);
      return restoreSalonData(salon.id, { name: asset.name, bytes });
    },
    onSuccess: (result) => {
      if (result) void queryClient.invalidateQueries();
    },
  });

  const share = async (result: DataExportResponse) => {
    if (Platform.OS === 'web') {
      const a = document.createElement('a');
      a.href = result.url;
      a.download = result.fileName;
      a.rel = 'noopener';
      a.click();
      return;
    }
    await Share.share({ title: result.fileName, message: result.url, url: result.url });
  };

  if (!isOwner) {
    return (
      <DetailScreen title="Export your data">
        <EmptyState
          icon="lock-closed-outline"
          title="Owners only"
          message="Ask the salon owner to export the salon's data."
        />
      </DetailScreen>
    );
  }

  const done = exporter.data;
  const restored = restorer.data;

  return (
    <DetailScreen title="Export your data">
      <Card className="gap-3">
        <Text variant="headline">Your data is yours</Text>
        <Text variant="body" tone="muted">
          Download everything {salon.name} keeps in Chairside: clients, appointments, services,
          payments, formulas, notes, forms, inventory, the waitlist, expenses and client photos. You
          get spreadsheets (CSV) for any app, plus a data.json file Chairside can restore from.
        </Text>
        <Button
          icon="download-outline"
          label={exporter.isPending ? 'Preparing your export…' : 'Export everything'}
          loading={exporter.isPending}
          disabled={exporter.isPending}
          onPress={() => exporter.mutate()}
        />
        {exporter.error ? (
          <Text variant="footnote" tone="destructive">
            {errorMessage(exporter.error)}
          </Text>
        ) : null}
      </Card>

      {done ? (
        <Card className="mt-3 gap-2">
          <Text variant="headline">Export ready</Text>
          <Text variant="footnote" tone="muted">
            {summarizeCounts(done.counts)}
          </Text>
          {done.photos.linked > 0 ? (
            <Text variant="footnote" tone="muted">
              {done.photos.linked} photos or receipts were too big to include; the zip has links to
              them.
            </Text>
          ) : null}
          <Text variant="body">
            {done.emailedTo
              ? `We emailed a download link to ${done.emailedTo}. It works for 24 hours.`
              : 'Save it now: this link works until ' + formatTime(done.expiresAt) + '.'}
          </Text>
          <View className="flex-row gap-2">
            <Button
              variant="secondary"
              icon={Platform.OS === 'web' ? 'download-outline' : 'share-outline'}
              label={Platform.OS === 'web' ? 'Download' : 'Share'}
              accessibilityLabel={`Share ${done.fileName}`}
              onPress={() => void share(done)}
            />
          </View>
        </Card>
      ) : null}

      <SectionHeader title="Restore" />
      <Card className="gap-3">
        <Text variant="body" tone="muted">
          Moving to a new salon account? Create the new salon, then choose a Chairside export here.
          Restore only works into a salon with no clients or appointments yet.
        </Text>
        <Button
          variant="secondary"
          icon="cloud-upload-outline"
          label={restorer.isPending ? 'Restoring…' : 'Choose export file'}
          loading={restorer.isPending}
          disabled={restorer.isPending}
          onPress={() => restorer.mutate()}
        />
        {restorer.error ? (
          <Text variant="footnote" tone="destructive">
            {errorMessage(restorer.error)}
          </Text>
        ) : null}
        {restored ? (
          <Text variant="footnote">
            Restored {summarizeCounts(restored.counts)}
            {restored.photos.failed > 0 ? ` (${restored.photos.failed} files failed)` : ''}.
          </Text>
        ) : null}
      </Card>
    </DetailScreen>
  );
}
