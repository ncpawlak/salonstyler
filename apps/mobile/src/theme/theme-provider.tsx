import { colorScheme as nativewindColorScheme, useColorScheme, vars } from 'nativewind';
import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { Platform, View } from 'react-native';

import {
  resolvePalette,
  serviceTags,
  toCssVariables,
  type ColorPalette,
  type ColorScheme,
  type ServiceTag,
  type ServiceTagColors,
  type ThemeOverrides,
} from './tokens';

export type ThemePreference = 'system' | ColorScheme;

type ThemeContextValue = {
  scheme: ColorScheme;
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
  colors: ColorPalette;
  tag: (tag: ServiceTag) => ServiceTagColors;
  overrides: ThemeOverrides;
  /** Runtime theme customization (salon branding, #47). */
  setOverrides: (overrides: ThemeOverrides) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({
  children,
  initialOverrides = {},
}: {
  children: ReactNode;
  initialOverrides?: ThemeOverrides;
}) {
  const { colorScheme } = useColorScheme();
  const scheme: ColorScheme = colorScheme === 'dark' ? 'dark' : 'light';
  const [preference, setPreferenceState] = useState<ThemePreference>('system');
  const [overrides, setOverrides] = useState<ThemeOverrides>(initialOverrides);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    nativewindColorScheme.set(next);
  }, []);

  const colors = useMemo(() => resolvePalette(scheme, overrides), [scheme, overrides]);
  const cssVars = useMemo(() => toCssVariables(colors), [colors]);

  // Web: put the variables on <html> so portals and the page background pick them up too.
  useLayoutEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    const root = document.documentElement;
    for (const [name, value] of Object.entries(cssVars)) root.style.setProperty(name, value);
    root.style.colorScheme = scheme;
    root.style.backgroundColor = colors.background;
  }, [cssVars, scheme, colors.background]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      scheme,
      preference,
      setPreference,
      colors,
      tag: (t) => serviceTags[scheme][t],
      overrides,
      setOverrides,
    }),
    [scheme, preference, setPreference, colors, overrides],
  );

  return (
    <ThemeContext.Provider value={value}>
      <View style={[{ flex: 1, backgroundColor: colors.background }, vars(cssVars)]}>
        {children}
      </View>
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>');
  return ctx;
}
