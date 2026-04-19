import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';
import { getAnalytics } from 'firebase/analytics';
import { getFirestore, initializeFirestore, persistentLocalCache, persistentMultipleTabManager } from 'firebase/firestore';
import { getFunctions } from 'firebase/functions';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY ?? 'AIzaSyD55-qa7l3mumHB3sTciw1P8xRf4moAUhs',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ?? 'roulette-diy.firebaseapp.com',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID ?? 'roulette-diy',
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET ?? 'roulette-diy.firebasestorage.app',
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID ?? '210783514149',
  appId: import.meta.env.VITE_FIREBASE_APP_ID ?? '1:210783514149:web:9c9f90b31f56c052cd59cc',
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID ?? 'G-PW5SH1M2HK',
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const analytics = getAnalytics(app);
export const googleProvider = new GoogleAuthProvider();

// Firestore with offline persistence across multiple tabs. Built-in cache
// replaces our ad-hoc localStorage layer for blocks/social data.
export const db = (() => {
  try {
    return initializeFirestore(app, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
      ignoreUndefinedProperties: true,
    });
  } catch {
    // Already initialized (e.g. HMR)
    return getFirestore(app);
  }
})();

export const fns = getFunctions(app, 'us-central1');

export const R2_PUBLIC_BASE_URL: string =
  import.meta.env.VITE_R2_PUBLIC_BASE_URL ?? 'https://pub-94b3c8e483504b6088238e20016b769b.r2.dev';
