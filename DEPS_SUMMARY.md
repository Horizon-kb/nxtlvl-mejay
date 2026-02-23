# MeJay Dependencies & Scripts Summary

**Generated:** 2026-02-23  
**Package Manager:** Bun (required; not npm)  
**Lock File:** bun.lock (174 KB)  
**Total Dependencies:** 60+ direct + 200+ transitive

---

## Direct Dependencies (Critical Path)

### UI Framework & Styling
- **react** ^18.3.1 — Core React library
- **react-dom** ^18.3.1 — DOM rendering
- **@vitejs/plugin-react-swc** ^3.11.0 — Vite React plugin (SWC compiler)
- **tailwindcss** ^3.4.17 — Utility-first CSS
- **@tailwindcss/typography** ^0.5.16 — Prose styling
- **tailwind-merge** ^2.6.0 — Class merging utility

### Component Libraries
- **@radix-ui/react-*** (30+ packages) — Accessible UI components
- **shadcn/ui** (via source) — Built-in component registry
- **lucide-react** ^0.462.0 — Icon library
- **framer-motion** ^12.29.0 — Animation library

### State Management
- **zustand** ^5.0.10 — Lightweight state store (used for djStore, planStore, etc.)

### Forms & Validation
- **react-hook-form** ^7.61.1 — Form state management
- **@hookform/resolvers** ^3.10.0 — Validation resolvers
- **zod** ^3.25.76 — TypeScript-first schema validation

### Storage & Database
- **idb** ^8.0.3 — Wrapper for IndexedDB (stores tracks, playlists, settings)

### Other Libraries
- **react-router-dom** ^6.30.1 — Client-side routing
- **sonner** ^1.7.4 — Toast notifications
- **date-fns** ^3.6.0 — Date utilities
- **clsx** ^2.1.1 — Class utility
- **embla-carousel-react** ^8.6.0 — Carousel component
- **react-day-picker** ^8.10.1 — Date picker
- **react-resizable-panels** ^2.1.9 — Draggable panel layouts
- **recharts** ^2.15.4 — Chart library
- **stripe** ^20.3.1 — Stripe SDK (for payments)
- **vaul** ^0.9.9 — Drawer component
- **class-variance-authority** ^0.7.1 — Component style composition
- **cmdk** ^1.1.1 — Command palette
- **input-otp** ^1.4.2 — OTP input
- **next-themes** ^0.3.0 — Theme management
- **@tanstack/react-query** ^5.83.0 — Server state management

### Development Dependencies
- **vite** ^5.4.19 — Build tool
- **typescript** ^5.8.3 — Type checker
- **eslint** ^9.32.0 + **@eslint/js** — Linter
- **vitest** ^3.2.4 — Test runner
- **@testing-library/react** ^16.0.0 — React testing utilities
- **@testing-library/jest-dom** ^6.6.0 — DOM matchers
- **jsdom** ^20.0.3 — DOM implementation for tests
- **wrangler** ^4.65.0 — Cloudflare Workers CLI
- **cross-env** ^10.1.0 — Cross-platform env vars
- **autoprefixer** ^10.4.21 — CSS prefixer
- **postcss** ^8.5.6 — CSS transformation
- **@types/react**, **@types/react-dom**, **@types/node** — Type definitions
- **globals** ^15.15.0 — Global identifiers
- **typescript-eslint** ^8.38.0 — TypeScript linting
- **eslint-plugin-react-hooks**, **eslint-plugin-react-refresh** — React linting
- **lovable-tagger** ^1.1.13 — Component tagging (dev only)

---

## Scripts

```bash
# Development
bun dev                 # Start Vite dev server (http://localhost:8080)
bun dev:pages          # Dev with Cloudflare Pages Functions
bun dev:vite           # Run Vite directly (no custom setup)

# Building
bun run build          # Production build (NODE_ENV=production, minified)
bun run build:dev      # Development mode build (not minified, debug info)
bun run preview        # Preview production build locally

# Code Quality
bun run lint           # ESLint check
bun run typecheck      # TypeScript type checking (3 configs checked)

# Testing
bun run test           # Run all tests once (Vitest)
bun run test:watch     # Watch mode
bun run test:bun       # Alternative: Bun's native test runner
bun run test:all       # Verbose test output
bun run test:coverage  # Coverage report
bun run test:ui        # Vitest UI

# Installation
bun install            # Install dependencies (uses bun.lock)
```

---

## Dependency Risk Assessment

### ✅ Low Risk (Well-Maintained, Stable)
- react, react-dom (by Meta)
- vite, typescript (industry standard)
- zustand (mature, minimal)
- zod (actively maintained)
- idb (Thin IndexedDB wrapper, stable)
- date-fns, clsx (utility libraries, stable)

### 🟡 Medium Risk (Tracking Actively)
- @radix-ui/\* (60+ packages, but high quality; monitor for bulk updates)
- framer-motion (animation library; breaking changes possible)
- stripe (payment SDK; monitor security updates)
- @tanstack/react-query (large ecosystem; monitor version compat)

### 🔴 High Risk (Requires Attention)
- None currently flagged for critical security issues
- **Note:** `lovable-tagger` is dev-only; safe to remove if unused

---

## Security Notes

### Sensitive Credentials
- **Stripe API Key:** Configured at build time, exposed in frontend (public key only; safe)
- **Resend API Key:** Backend-only (Cloudflare Functions); not in client code
- **Auth Bypass:** `VITE_AUTH_BYPASS=1` only in dev; guards prevent prod misconfig

### Audit Status
- Last audit: Not yet run (Phase 1 is read-only)
- Recommendation: `npm audit` (read-only, no fix) recommended before Phase 2+
- Known vulnerabilities: TBD (audit not run per owner request)

### Storage Security
- Audio blobs: Stored in IndexedDB (browser-local, not transmitted unless user exports)
- Settings: Stored in IndexedDB (user preferences, no sensitive data)
- Session: Cookie-based (from `/api/auth/verify`); HttpOnly + Secure flags expected

---

## Lock File Status

**bun.lock:** 174 KB (binary format; machine-readable)
- Generated by `bun install`
- Ensures reproducible builds
- Should be committed to git

**package-lock.json:** Also present (legacy from npm; can coexist)
- Not used if bun.lock exists
- Safe to ignore for Bun workflow

---

## Breaking Change Flags (Known)

### Radix UI Major Version Updates
If upgrading `@radix-ui/react-*` packages together, test component behavior:
- `@radix-ui/react-dialog` — Refactored in v1.1+
- `@radix-ui/react-dropdown-menu` — API changes possible

### React 19 Migration
Current: React 18.3.1  
Upgrade to React 19 when available; potential breaking changes:
- Ref handling
- Context API behavior
- Suspense semantics

---

## Recommended Dependency Maintenance Schedule

| Task | Frequency | Owner |
|------|-----------|-------|
| `bun install` (new deps) | Per feature | Dev |
| `npm audit` (read-only) | Monthly | Horizon |
| Security patch updates | ASAP if critical | John |
| Major version reviews | Quarterly | John |
| Transitive dep cleanup | Quarterly | Dev |

---

## Commands for Phase 2+ (If Needed)

```bash
# Read-only audit
bun audit                      # Not bun-native; use npm
npm audit                      # Shows vulnerabilities without fixing

# Conservative fix (Phase 2 only, if owner approves)
npm audit fix                  # Fixes patch/minor only (no --force)
npm audit fix --force          # ⚠️ Allow breaking changes (not recommended)
```

---

## Notes for Horizon

**Current Phase (Phase 1):**
- ✅ Do: Read package.json, understand dependency graph
- ✅ Do: Document audit readiness
- ❌ Don't: Run `bun install` or `npm audit`
- ❌ Don't: Suggest upgrades without owner approval

**Phase 2+ (If Approved):**
- Only run `npm audit` (read-only, no fix)
- Report findings in FIX_BACKLOG.md
- Wait for owner approval before `npm audit fix`
- Use conservative flag (no --force)

---

**Status:** 🟡 Read-Only Assessment  
**Generated:** 2026-02-23 by Horizon  
**Owner Review:** Pending approval before moving to Phase 2
