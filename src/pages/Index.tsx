import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { TabBar } from '@/components/TabBar';
import { LibraryView } from '@/components/LibraryView';
import { PartyModeView } from '@/components/PartyModeView';
import { PlaylistsView } from '@/components/PlaylistsView';
import { useDJStore } from '@/stores/djStore';
import { useSearchParams } from 'react-router-dom';
import { DevPlanSwitcher } from '@/components/DevPlanSwitcher';
import { UpgradeModal } from '@/components/UpgradeModal';
import { TopRightSettingsMenu } from '@/components/TopRightSettingsMenu';
import { cn } from '@/lib/utils';
import { MEJAY_LOGO_URL } from '@/lib/branding';
import { ENTITLEMENTS_CHANGED_EVENT, usePlanStore } from '@/stores/planStore';
import { StarterPacksOnboardingModal } from '@/components/StarterPacksOnboardingModal';
import { consumeStarterPromptPending, readStarterPacksPrefs, setStarterPromptPending } from '@/lib/starterPacksPrefs';
import { startCheckout } from '@/lib/checkout';
import { toast } from '@/hooks/use-toast';

type TabId = 'library' | 'party' | 'playlists';

const LAST_TAB_KEY = 'mejay:lastTab';

const Index = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const tabFromUrl = searchParams.get('tab') as TabId | null;
  const upgradeParam = searchParams.get('upgrade') as 'pro' | 'full_program' | null;
  const authStatus = usePlanStore((s) => s.authStatus);
  const [starterPacksOpen, setStarterPacksOpen] = useState(false);
  const [isFading, setIsFading] = useState(false);
  const [activeTab, setActiveTab] = useState<TabId>(() => {
    if (tabFromUrl && ['library', 'party', 'playlists'].includes(tabFromUrl)) return tabFromUrl;
    try {
      const stored = sessionStorage.getItem(LAST_TAB_KEY) as TabId | null;
      if (stored && ['library', 'party', 'playlists'].includes(stored)) return stored;
    } catch {
      // ignore
    }
    return 'library';
  });

  // Handle smooth tab transitions
  const switchTab = (tab: TabId) => {
    if (tab === activeTab) return; // Don't fade if already on this tab
    
    setIsFading(true);
    
    setTimeout(() => {
      setActiveTab(tab);
      setIsFading(false);
    }, 160);
  };

  // Set starter packs prompt flag on first entry
  useEffect(() => {
    try {
      const choiceMade = localStorage.getItem('mejay:starterPacksChoiceMade');
      const pending = localStorage.getItem('mejay:starterPromptPending');
      
      // If they haven't made a choice and we're not already pending, set the flag
      if (!choiceMade && !pending) {
        setStarterPromptPending(true);
      }
    } catch {
      // ignore localStorage errors
    }
  }, []);

  // Handle auto-checkout after login
  useEffect(() => {
    if (!upgradeParam || authStatus === 'unknown') return;
    if (upgradeParam !== 'pro' && upgradeParam !== 'full_program') return;
    
    // User is authenticated, start checkout
    if (authStatus === 'authenticated') {
      // Remove the upgrade param from URL
      const newParams = new URLSearchParams(searchParams);
      newParams.delete('upgrade');
      setSearchParams(newParams, { replace: true });
      
      // Start checkout
      void startCheckout(upgradeParam, 'trial', 'monthly').catch((e) => {
        toast({
          title: 'Checkout failed',
          description: e instanceof Error ? e.message : 'Could not start checkout.',
          variant: 'destructive',
        });
      });
    }
  }, [upgradeParam, authStatus, searchParams, setSearchParams]);

  // Initialize app data on mount only
  useEffect(() => {
    const maybeOpenStarterPacks = () => {
      const pending = consumeStarterPromptPending();
      if (!pending) return;

      const prefs = readStarterPacksPrefs();
      if (prefs.choiceMade) return;

      setStarterPacksOpen(true);
    };

    void useDJStore.getState().loadTracks().finally(maybeOpenStarterPacks);
    useDJStore.getState().loadPlaylists();
    useDJStore.getState().loadSettings();

    // If entitlements/plan changes after initial load (common on reload/login/upgrade),
    // ensure tempo presets/settings are applied to the engine immediately.
    const handleEntitlementsChanged = () => {
      useDJStore.getState().syncTempoNow({ reason: 'entitlements_changed' });
    };

    try {
      window.addEventListener(ENTITLEMENTS_CHANGED_EVENT, handleEntitlementsChanged as EventListener);
    } catch {
      // ignore
    }

    return () => {
      try {
        window.removeEventListener(ENTITLEMENTS_CHANGED_EVENT, handleEntitlementsChanged as EventListener);
      } catch {
        // ignore
      }
    };
  }, []);

  // Sync tab from URL
  useEffect(() => {
    if (tabFromUrl && ['library', 'party', 'playlists'].includes(tabFromUrl)) {
      setActiveTab(tabFromUrl);
    }
  }, [tabFromUrl]);

  // Persist tab selection so refresh returns you to the same view.
  useEffect(() => {
    try {
      sessionStorage.setItem(LAST_TAB_KEY, activeTab);
    } catch {
      // ignore
    }
  }, [activeTab]);

  return (
    <motion.div
      initial={{ opacity: 0, scale: 1.02 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.3, ease: "easeOut" }}
      className="mejay-screen relative mejay-viewport flex flex-col"
    >
      {/* Dev Plan Switcher */}
      <DevPlanSwitcher />

      {/* Settings Menu */}
      <TopRightSettingsMenu className="mejay-fixed-right" />

      {/* Upgrade Modal */}
      <UpgradeModal />

      {/* Starter Packs Onboarding */}
      <StarterPacksOnboardingModal open={starterPacksOpen} onOpenChange={setStarterPacksOpen} />

      {/* Background Orbs - Fixed positioning to prevent layout shift */}
      <div className="fixed w-[250px] h-[250px] -top-20 -right-20 pointer-events-none" style={{ contain: 'layout' }}>
        <div className="orb orb-primary w-full h-full opacity-50" />
      </div>
      <div className="fixed w-[200px] h-[200px] bottom-[180px] -left-[100px] pointer-events-none" style={{ contain: 'layout' }}>
        <div className="orb orb-secondary w-full h-full opacity-50" />
      </div>
      <div className="fixed w-[180px] h-[180px] -bottom-10 -right-10 pointer-events-none" style={{ contain: 'layout' }}>
        <div className="orb orb-accent w-full h-full opacity-50" />
      </div>

      {/* Main Content */}
      <div
        className={cn(
          'relative z-10 flex flex-col flex-1 min-h-0 px-5',
          // Reserve space for the fixed tab bar.
          activeTab === 'party'
            ? 'pt-3 overflow-visible md:overflow-hidden'
            : 'pt-14 overflow-visible md:overflow-hidden'
        )}
      >
        {/* Logo Header (hide in Party Mode to maximize usable viewport) */}
        {activeTab !== 'party' && (
          <div className="flex justify-center mb-3 flex-shrink-0">
            <img
              src={MEJAY_LOGO_URL}
              alt="MEJay"
              width="400"
              height="256"
              className="h-64 w-auto object-contain drop-shadow-[0_18px_60px_rgba(0,0,0,0.55)]"
              style={{ aspectRatio: '200/128' }}
              fetchPriority="high"
              decoding="async"
            />
          </div>
        )}

        {/* Tab Content */}
        <div
          className={cn(
            'flex-1 min-h-0 tab-content',
            isFading && 'fade-out',
            // On phones, allow full-page scroll; on md+ keep panel-based scrolling.
            activeTab === 'party' ? 'overflow-visible md:overflow-hidden' : 'overflow-visible md:overflow-hidden'
          )}
        >
          {activeTab === 'library' && <LibraryView />}
          {activeTab === 'party' && <PartyModeView />}
          {activeTab === 'playlists' && <PlaylistsView />}
        </div>
      </div>

      {/* Tab Bar */}
      <TabBar activeTab={activeTab} onTabChange={switchTab} />
    </motion.div>
  );
};

export default Index;
