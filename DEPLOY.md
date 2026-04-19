# Deployment — one-time setup

## 1. Firebase Console (you)

- Open the `roulette-diy` Firebase project.
- **Authentication → Sign-in method** → Google: Enable. Set project support email.
- **Authentication → Settings → Authorized domains**: add `localhost`, `roulette.diy`, `www.roulette.diy`, `roulette-diy.web.app`, `roulette-diy.firebaseapp.com`.
- **Firestore Database** → Create database, start in **Native mode**, pick region (`us-central1` or nearest). Start in "test mode" — we'll override with the rules in this repo.
- **Upgrade to Blaze plan** (Settings → Usage and billing). Required for Cloud Functions. Free-tier quotas still apply.

## 2. Cloudflare R2 (you)

- `roulette-diy-assets` bucket: Settings → CORS policy → paste the JSON you already have (localhost ports + roulette.diy).
- Public access: ensure the `pub-94b3...r2.dev` URL is enabled (or attach a custom domain later).
- **Rotate the R2 token** you pasted in chat once deploy succeeds — create a new one, update `functions/.env.local` + Firebase Functions secrets, revoke the old one.

## 3. Firebase CLI (from this repo, once)

```bash
npx firebase login            # browser auth
npx firebase use roulette-diy # or rely on .firebaserc default
```

## 4. Deploy Firestore rules + indexes

```bash
npx firebase deploy --only firestore:rules,firestore:indexes
```

If an index is missing at query time, Firestore will log a URL that auto-creates it — paste that URL in a browser and wait for the index to build.

## 5. Set Cloud Function secrets (don't commit real secrets)

```bash
npx firebase functions:secrets:set R2_ACCESS_KEY_ID
npx firebase functions:secrets:set R2_SECRET_ACCESS_KEY
npx firebase functions:secrets:set R2_ACCOUNT_ID
npx firebase functions:secrets:set R2_BUCKET_NAME
npx firebase functions:secrets:set R2_S3_ENDPOINT
npx firebase functions:secrets:set R2_PUBLIC_BASE_URL
```

Then in `functions/src/issueUploadUrl.ts` bind those secrets on the function decorator (open a PR to wire this up for prod — currently reads from `process.env`, which works in emulator with `functions/.env.local`).

## 6. Deploy Functions

```bash
npx firebase deploy --only functions
```

## 7. Deploy hosting (optional — if using Firebase Hosting)

```bash
npm run build
npx firebase deploy --only hosting
```

---

# Local development

## Client

```bash
npm run dev
```

## Functions emulator (for testing presigned URLs locally)

```bash
# Terminal 1 — functions
cd functions && npm run build:watch

# Terminal 2 — emulators
npx firebase emulators:start --only functions,firestore,auth
```

The client's `getFunctions()` call doesn't currently point at the emulator. To test against emulators, add this to `src/firebase.ts` under an env flag:

```ts
import { connectFunctionsEmulator } from 'firebase/functions';
if (import.meta.env.DEV && import.meta.env.VITE_USE_EMULATOR === '1') {
  connectFunctionsEmulator(fns, 'localhost', 5001);
}
```

---

# Environment variables checklist

**Client** (`.env.local`, gitignored):
- `VITE_FIREBASE_*` — already filled in
- `VITE_R2_PUBLIC_BASE_URL` — R2 public CDN URL

**Functions runtime** (`functions/.env.local` for emulator; Secret Manager for prod):
- `R2_ACCOUNT_ID`
- `R2_BUCKET_NAME`
- `R2_S3_ENDPOINT`
- `R2_ACCESS_KEY_ID`    ← rotate once committed workflow is verified
- `R2_SECRET_ACCESS_KEY`← rotate once committed workflow is verified
- `R2_PUBLIC_BASE_URL`
