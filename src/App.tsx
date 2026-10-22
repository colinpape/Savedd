// NOTE: This file should normally not be modified unless you are adding a new provider.
// To add new routes, edit the AppRouter.tsx file.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createHead, UnheadProvider } from '@unhead/react/client';
import { InferSeoMetaPlugin } from 'unhead/plugins';
import { Suspense } from 'react';
import NostrProvider from '@/components/NostrProvider';
import { NostrSync } from '@/components/NostrSync';
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { NostrLoginProvider } from '@nostrify/react/login';
import { AppProvider } from '@/components/AppProvider';
import { AppConfig } from '@/contexts/AppContext';
import { APP_RELAYS } from '@/lib/appRelays';
import { getBrowserLanguage } from '@/lib/languageFilter';
import { ENGINE_PROFILE } from '@/lib/engine/profile';
import { ReferralCapture } from '@/components/ReferralCapture';
import { ReferralEnrollment } from '@/components/ReferralEnrollment';
import AppRouter from './AppRouter';

const head = createHead({
  plugins: [
    InferSeoMetaPlugin(),
  ],
});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 60000, // 1 minute
      gcTime: Infinity,
    },
  },
});

const defaultConfig: AppConfig = {
  theme: ENGINE_PROFILE.branding.defaultTheme,
  // App relays: what the app needs to run (device-local, never published).
  relayMetadata: APP_RELAYS,
  // Your relays: the logged-in user's own NIP-65 list — synced on login.
  // Off by default: the app runs on its own App Relays until the user opts in.
  userRelayMetadata: { relays: [], updatedAt: 0 },
  useUserRelays: false,
  blossomServerMetadata: {
    servers: [
      'https://blossom.ditto.pub/',
      'https://blossom.dreamith.to/',
      'https://blossom.primal.net/',
    ],
    updatedAt: 0,
  },
  useAppBlossomServers: true,
  privacyMode: false,
  autoIndex: true,
  tabConfig: ENGINE_PROFILE.ui.tabConfig,
  voteWithIdentity: false,
  // Community-engine defaults: SIP-01 + Brave + DuckDuckGo + SearXNG on.
  // Everything else stays in the architecture; users can re-enable it in
  // Settings → Engines. See ENGINE_PROFILE.search.disabledProviders.
  disabledProviders: ENGINE_PROFILE.search.disabledProviders,
  // Language filter defaults to the browser's primary language (English
  // when it can't be detected). Only applies while the user has never
  // touched the filter — a stored choice, including a cleared one, wins.
  languageFilter: [getBrowserLanguage()],
};

export function App() {
  return (
    <UnheadProvider head={head}>
      <AppProvider storageKey="savedd:app-config" defaultConfig={defaultConfig}>
        <QueryClientProvider client={queryClient}>
          <NostrLoginProvider storageKey='nostr:login'>
            <NostrProvider>
              <NostrSync />
              {/* Invite Friends capture (?ref=npub…) — inside providers so the
                  self-referral guard can see the logged-in user. */}
              <ReferralCapture />
              <ReferralEnrollment />
              <TooltipProvider>
                <Toaster />
                <Suspense>
                  <AppRouter />
                </Suspense>
              </TooltipProvider>
            </NostrProvider>
          </NostrLoginProvider>
        </QueryClientProvider>
      </AppProvider>
    </UnheadProvider>
  );
}

export default App;
