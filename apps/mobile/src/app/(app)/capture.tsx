import type { ManualCaptureResponse } from '@chairside/ai/inbox';
import * as Clipboard from 'expo-clipboard';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { router, useLocalSearchParams } from 'expo-router';
import { useShareIntent } from 'expo-share-intent';
import { useEffect, useEffectEvent, useState } from 'react';
import { Image, Platform, View } from 'react-native';

import { DetailScreen } from '@/components/shell/screen';
import { Button, Card, Icon, Input, Text } from '@/components/ui';
import {
  type CaptureImage,
  captureSummary,
  channelLabel,
  dataUriToImage,
  senderFields,
  sharedText,
  toCaptureImage,
} from '@/features/inbox/capture';
import { useCaptureRequest } from '@/features/inbox/capture-api';
import { haptics } from '@/lib/haptics';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const MAX_WIDTH = 1280;

/** A shared or picked file (maybe HEIC, maybe huge) → a JPEG the vision model can read. */
async function fileToImage(uri: string, width?: number | null): Promise<CaptureImage> {
  const context = ImageManipulator.manipulate(uri);
  if (!width || width > MAX_WIDTH) context.resize({ width: MAX_WIDTH });
  const rendered = await context.renderAsync();
  const saved = await rendered.saveAsync({ base64: true, compress: 0.7, format: SaveFormat.JPEG });
  return toCaptureImage('image/jpeg', saved.base64 ?? '');
}

async function pickScreenshot(): Promise<CaptureImage | null> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    quality: 0.7,
    base64: true,
  });
  const asset = result.canceled ? null : result.assets[0];
  if (!asset) return null;
  const fromUri = asset.uri.startsWith('data:') ? dataUriToImage(asset.uri) : null;
  if (fromUri) return fromUri;
  const mimeType = asset.mimeType ?? asset.file?.type ?? 'image/jpeg';
  if (asset.base64 && mimeType !== 'image/heic') return toCaptureImage(mimeType, asset.base64);
  return fileToImage(asset.uri, asset.width);
}

/**
 * Manual capture (#2): a client's message pasted, shared from another app, or screenshotted (an
 * Instagram DM, WhatsApp, iMessage…). It goes through the same inbox pipeline as a forwarded text,
 * so it shows up as the same Inbox card with a slot already held.
 */
export default function CaptureScreen() {
  const params = useLocalSearchParams<{ shared?: string }>();
  const capture = useCaptureRequest();
  const share = useShareIntent({ disabled: Platform.OS === 'web', resetOnBackground: true });
  const [text, setText] = useState('');
  const [from, setFrom] = useState('');
  const [image, setImage] = useState<CaptureImage | null>(null);
  const [fromShare, setFromShare] = useState(params.shared === '1');
  const [busy, setBusy] = useState<'paste' | 'image' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ManualCaptureResponse | null>(null);

  const { hasShareIntent, shareIntent } = share;
  const [handledShare, setHandledShare] = useState<typeof shareIntent | null>(null);
  // A new share (the extension opened the app): fill the form from it.
  if (hasShareIntent && shareIntent !== handledShare) {
    setHandledShare(shareIntent);
    setFromShare(true);
    setResult(null);
    setError(null);
    const shared = sharedText(shareIntent.text, shareIntent.webUrl);
    if (shared) setText(shared);
  }
  const clearShare = useEffectEvent(() => share.resetShareIntent());
  useEffect(() => {
    if (!handledShare) return;
    // Clear it natively so coming back to this screen doesn't refill it.
    clearShare();
    const file = handledShare.files?.find((f) => f.mimeType.startsWith('image/'));
    if (!file) return;
    let live = true;
    fileToImage(file.path, file.width)
      .then((img) => live && setImage(img))
      .catch((e: unknown) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [handledShare]);

  const paste = async () => {
    setError(null);
    setBusy('paste');
    try {
      if (await Clipboard.hasImageAsync().catch(() => false)) {
        const clip = await Clipboard.getImageAsync({ format: 'jpeg', jpegQuality: 0.7 });
        const pasted = clip ? dataUriToImage(clip.data) : null;
        if (pasted) {
          setImage(pasted);
          return;
        }
      }
      const clipText = (await Clipboard.getStringAsync()).trim();
      if (!clipText) throw new Error('Your clipboard is empty. Copy the client’s message first.');
      setText(clipText.slice(0, 4000));
    } catch (e) {
      setError(
        e instanceof Error && /clipboard is empty/.test(e.message)
          ? e.message
          : 'Couldn’t read the clipboard. Paste into the box instead.',
      );
    } finally {
      setBusy(null);
    }
  };

  const chooseImage = async () => {
    setError(null);
    setBusy('image');
    try {
      const picked = await pickScreenshot();
      if (picked) setImage(picked);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const submit = () => {
    setError(null);
    const source = fromShare ? 'share' : image ? 'screenshot' : 'paste';
    capture.mutate(
      {
        source,
        ...(text.trim() ? { text: text.trim() } : {}),
        ...senderFields(from),
        ...(image ? { image } : {}),
      },
      {
        onSuccess: (outcome) => {
          haptics.success();
          setResult(outcome);
        },
        onError: (e) => {
          haptics.error();
          setError(errorText(e));
        },
      },
    );
  };

  const reset = () => {
    setText('');
    setFrom('');
    setImage(null);
    setFromShare(false);
    setResult(null);
    setError(null);
  };

  if (result) {
    const summary = captureSummary(result);
    return (
      <DetailScreen title="Add a request">
        <View className="gap-4">
          <Card className="gap-3" testID="capture-result">
            <View className="flex-row items-center gap-3">
              <Icon
                name={summary.toInbox ? 'checkmark-circle' : 'information-circle-outline'}
                color={summary.toInbox ? 'success' : 'muted'}
              />
              <View className="flex-1">
                <Text variant="headline">{summary.title}</Text>
                {summary.detail ? (
                  <Text variant="footnote" tone="muted">
                    {summary.detail}
                  </Text>
                ) : null}
              </View>
            </View>
            {result.read ? (
              <View className="gap-1 rounded-xl bg-muted/40 px-3 py-2" testID="capture-read">
                <Text variant="footnote" tone="muted">
                  {[
                    channelLabel(
                      result.read.platform === 'other' ? 'screenshot' : result.read.platform,
                      null,
                    ),
                    result.read.sender,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </Text>
                <Text variant="subhead">{result.read.text}</Text>
              </View>
            ) : null}
          </Card>
          {summary.toInbox ? (
            <Button
              label="Open Inbox"
              icon="file-tray-outline"
              fullWidth
              onPress={() => router.replace('/inbox')}
              testID="capture-open-inbox"
            />
          ) : null}
          <Button
            label="Add another"
            variant="outline"
            fullWidth
            onPress={reset}
            testID="capture-again"
          />
        </View>
      </DetailScreen>
    );
  }

  const disabled = busy !== null || capture.isPending;
  return (
    <DetailScreen title="Add a request">
      <View className="gap-4">
        <Text variant="subhead" tone="muted" className="px-1">
          Got a booking request in Instagram, WhatsApp or anywhere else? Paste the message or add a
          screenshot of the conversation. It lands in your Inbox with a time already held, just like
          a forwarded text.
        </Text>

        {error ? (
          <View
            accessibilityRole="alert"
            accessibilityLiveRegion="polite"
            className="rounded-xl bg-destructive/10 px-4 py-3"
            testID="capture-error"
          >
            <Text variant="subhead" tone="destructive">
              {error}
            </Text>
          </View>
        ) : null}

        <Card className="gap-3">
          <View className="flex-row items-center gap-3">
            <Icon name="chatbubble-ellipses-outline" color="primary" />
            <View className="flex-1">
              <Text variant="headline">Their message</Text>
              <Text variant="footnote" tone="muted">
                Copy it from the other app, then tap Paste request.
              </Text>
            </View>
          </View>
          <Input
            value={text}
            onChangeText={setText}
            placeholder="Hey! can I get color + trim fri afternoon?"
            multiline
            numberOfLines={5}
            maxLength={4000}
            className="min-h-28"
            textAlignVertical="top"
            testID="capture-text"
          />
          <Button
            label="Paste request"
            icon="clipboard-outline"
            variant="outline"
            fullWidth
            loading={busy === 'paste'}
            disabled={disabled}
            onPress={() => void paste()}
            testID="capture-paste"
          />
        </Card>

        <Card className="gap-3">
          <View className="flex-row items-center gap-3">
            <Icon name="image-outline" color="primary" />
            <View className="flex-1">
              <Text variant="headline">Screenshot</Text>
              <Text variant="footnote" tone="muted">
                A screenshot of the chat. Your salon’s AI reads who sent it, what they asked and
                when (Settings → AI).
              </Text>
            </View>
          </View>
          {image ? (
            <View className="gap-2">
              <Image
                source={{ uri: `data:${image.mimeType};base64,${image.data}` }}
                accessibilityLabel="Screenshot to read"
                className="h-48 w-full rounded-xl"
                resizeMode="contain"
                testID="capture-image-preview"
              />
              <Button
                label="Remove screenshot"
                icon="close"
                variant="ghost"
                size="sm"
                disabled={disabled}
                onPress={() => setImage(null)}
              />
            </View>
          ) : null}
          <Button
            label={image ? 'Choose a different screenshot' : 'Choose screenshot'}
            icon="image-outline"
            variant="outline"
            fullWidth
            loading={busy === 'image'}
            disabled={disabled}
            onPress={() => void chooseImage()}
            testID="capture-image"
          />
        </Card>

        <Input
          label="From (optional)"
          value={from}
          onChangeText={setFrom}
          placeholder="Name or phone, if it isn’t in the message"
          autoCorrect={false}
          maxLength={200}
          testID="capture-from"
        />

        <Button
          label="Add to Inbox"
          icon="arrow-forward"
          fullWidth
          loading={capture.isPending}
          disabled={disabled || (!text.trim() && !image)}
          onPress={submit}
          testID="capture-submit"
        />
      </View>
    </DetailScreen>
  );
}
