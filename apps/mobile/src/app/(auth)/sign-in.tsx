import * as AppleAuthentication from 'expo-apple-authentication';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { Button, ErrorText, Field, Screen } from '@/components/form';
import {
  isAppleSignInAvailable,
  sendEmailCode,
  signInWithApple,
  verifyEmailCode,
} from '@/lib/auth';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function message(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong. Please try again.';
}

export default function SignInScreen() {
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [appleAvailable, setAppleAvailable] = useState(false);

  useEffect(() => {
    void isAppleSignInAvailable().then(setAppleAvailable);
  }, []);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const sendCode = () =>
    run(async () => {
      await sendEmailCode(email);
      setCode('');
      setStep('code');
    });

  // On success the session provider sees the new session and the root guard routes onward.
  const verify = () => run(() => verifyEmailCode(email, code));

  if (step === 'code') {
    return (
      <Screen title="Check your email" subtitle={`Enter the 6-digit code we sent to ${email}.`}>
        <Field
          label="Code"
          value={code}
          onChangeText={(t) => setCode(t.replace(/\D/g, '').slice(0, 6))}
          keyboardType="number-pad"
          textContentType="oneTimeCode"
          autoComplete="one-time-code"
          placeholder="123456"
          maxLength={6}
          autoFocus
          onSubmitEditing={() => code.length === 6 && void verify()}
        />
        <ErrorText>{error}</ErrorText>
        <Button title="Continue" onPress={verify} loading={busy} disabled={code.length !== 6} />
        <Button title="Resend code" variant="link" onPress={sendCode} disabled={busy} />
        <Button
          title="Use a different email"
          variant="link"
          onPress={() => {
            setError(null);
            setStep('email');
          }}
          disabled={busy}
        />
      </Screen>
    );
  }

  return (
    <Screen title="Chairside" subtitle="Sign in or create your account.">
      <Field
        label="Email"
        value={email}
        onChangeText={setEmail}
        keyboardType="email-address"
        textContentType="emailAddress"
        autoComplete="email"
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="you@salon.com"
        onSubmitEditing={() => EMAIL_PATTERN.test(email.trim()) && void sendCode()}
      />
      <ErrorText>{error}</ErrorText>
      <Button
        title="Email me a code"
        onPress={sendCode}
        loading={busy}
        disabled={!EMAIL_PATTERN.test(email.trim())}
      />
      {appleAvailable ? (
        <View className="h-12">
          <AppleAuthentication.AppleAuthenticationButton
            buttonType={AppleAuthentication.AppleAuthenticationButtonType.CONTINUE}
            buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
            cornerRadius={8}
            style={{ flex: 1 }}
            onPress={() => void run(async () => void (await signInWithApple()))}
          />
        </View>
      ) : null}
    </Screen>
  );
}
